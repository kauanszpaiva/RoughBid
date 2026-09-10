import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createBillingEndpointHandler, type BillingEndpointDependencies } from '../src/billing/endpoints.ts';
import { ProjectPayments } from '../src/billing/project-payments.ts';
import type { StripeEvent } from '../src/billing/stripe.ts';

const secret = 'whsec_project_payment_lifecycle_test';

function signedWebhook(event: StripeEvent, valid = true): Request {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac('sha256', valid ? secret : 'whsec_wrong')
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return new Request('https://roughbid.test/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'stripe-signature': `t=${timestamp},v1=${digest}` },
    body,
  });
}

function fixture() {
  const projectEvents = new Set<string>();
  const stripeEvents = new Set<string>();
  const transitions: Array<{ kind: 'paid' | 'revoked'; eventId: string }> = [];
  let quote = { id: 'quote-1', payment_intent_id: null as string | null, status: 'quoted' };

  const db = {
    from(table: string) {
      const query: any = {
        select: () => query,
        eq: (_column: string, value: unknown) => {
          if (table === 'project_reading_quotes' && value !== 'pi_project') query.noMatch = true;
          return query;
        },
        maybeSingle: () => query,
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          return Promise.resolve({ data: query.noMatch ? null : quote, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name: string, args: Record<string, any>) {
      if (name === 'confirm_project_reading_payment') {
        if (projectEvents.has(args.p_event_id)) return { data: false, error: null };
        projectEvents.add(args.p_event_id);
        assert.equal(args.p_quote_id, quote.id);
        assert.equal(args.p_session_id, 'cs_project');
        assert.equal(args.p_payment_intent, 'pi_project');
        assert.equal(args.p_amount, 500);
        assert.equal(args.p_currency, 'usd');
        assert.equal(args.p_livemode, false);
        quote = { ...quote, payment_intent_id: args.p_payment_intent, status: 'paid' };
        transitions.push({ kind: 'paid', eventId: args.p_event_id });
        return { data: true, error: null };
      }
      if (name === 'revoke_project_reading_payment') {
        if (projectEvents.has(args.p_event_id)) return { data: false, error: null };
        projectEvents.add(args.p_event_id);
        assert.equal(args.p_quote_id, quote.id);
        assert.equal(args.p_payment_intent, quote.payment_intent_id);
        assert.equal(args.p_livemode, false);
        quote = { ...quote, status: 'revoked' };
        transitions.push({ kind: 'revoked', eventId: args.p_event_id });
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    },
  };

  const payments = new ProjectPayments(db, {});
  const forbidden = async (): Promise<never> => { throw new Error('Unexpected Stripe or authentication call'); };
  const deps: BillingEndpointDependencies = {
    config: { mode: 'test', productId: '', priceId: null, priceIds: {} },
    webhookSecret: secret,
    authenticate: forbidden,
    stripe: { createCheckoutSession: forbidden, createPortalSession: forbidden },
    repository: {
      customerIdForUser: forbidden,
      processStripeEvent: async event => {
        if (stripeEvents.has(event.id)) return false;
        stripeEvents.add(event.id);
        return true;
      },
    },
    reconcileProjectPayment: event => payments.reconcile(event),
  };

  return {
    handler: createBillingEndpointHandler(deps),
    transitions,
    status: () => quote.status,
    projectEvents,
    stripeEvents,
  };
}

const paidEvent: StripeEvent = {
  id: 'evt_paid',
  type: 'checkout.session.completed',
  livemode: false,
  data: { object: {
    id: 'cs_project', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_project',
    amount_total: 500, currency: 'USD', metadata: { roughbid_quote_id: 'quote-1' },
  } },
};

test('signed paid project webhook grants once and duplicate replay remains idempotent', async () => {
  const f = fixture();
  const first = await f.handler(signedWebhook(paidEvent));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { received: true, duplicate: false });
  assert.equal(f.status(), 'paid');
  assert.deepEqual(f.transitions, [{ kind: 'paid', eventId: 'evt_paid' }]);

  const replay = await f.handler(signedWebhook(paidEvent));
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { received: true, duplicate: true });
  assert.deepEqual(f.transitions, [{ kind: 'paid', eventId: 'evt_paid' }]);
});

test('failed, unpaid, and invalidly signed payment events never authorize a project run', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  const f = fixture();
  const failedTypes = ['checkout.session.async_payment_failed', 'payment_intent.payment_failed'];
  for (const [index, type] of failedTypes.entries()) {
    const event: StripeEvent = {
      id: `evt_failed_${index}`, type, livemode: false,
      data: { object: { id: 'cs_project', mode: 'payment', payment_status: 'unpaid',
        payment_intent: 'pi_project', amount_total: 500, currency: 'usd', metadata: { roughbid_quote_id: 'quote-1' } } },
    };
    const response = await f.handler(signedWebhook(event));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: true, duplicate: false });
  }

  const unpaid: StripeEvent = { ...paidEvent, id: 'evt_unpaid', data: { object: { ...(paidEvent.data.object as object), payment_status: 'unpaid' } } };
  assert.equal((await f.handler(signedWebhook(unpaid))).status, 200);
  assert.equal((await f.handler(signedWebhook(paidEvent, false))).status, 400);
  assert.equal(f.status(), 'quoted');
  assert.deepEqual(f.transitions, []);
  assert.equal(f.projectEvents.size, 0);
  assert.equal(f.stripeEvents.size, 3);
});

test('signed refund and dispute revoke a paid project once without re-granting it', async () => {
  for (const revocation of [
    { id: 'evt_refund', type: 'charge.refunded', object: { payment_intent: 'pi_project', amount_refunded: 100 } },
    { id: 'evt_dispute', type: 'charge.dispute.created', object: { payment_intent: 'pi_project' } },
  ]) {
    const f = fixture();
    await f.handler(signedWebhook(paidEvent));
    const event: StripeEvent = { id: revocation.id, type: revocation.type, livemode: false, data: { object: revocation.object } };
    const first = await f.handler(signedWebhook(event));
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { received: true, duplicate: false });
    assert.equal(f.status(), 'revoked');
    assert.deepEqual(f.transitions.map(item => item.kind), ['paid', 'revoked']);

    const replay = await f.handler(signedWebhook(event));
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { received: true, duplicate: true });
    assert.deepEqual(f.transitions.map(item => item.kind), ['paid', 'revoked']);
  }
});
