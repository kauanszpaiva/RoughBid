import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRawPostHandler } from '../../../api/_bridge.ts';
import { POST } from '../../../api/webhooks/stripe.ts';
import { createBillingEndpointHandler, type BillingEndpointDependencies } from '../src/billing/endpoints.ts';

const event = { id: 'evt_raw_test', type: 'checkout.session.completed', livemode: false,
  data: { object: { id: 'cs_test', mode: 'payment', payment_status: 'paid', metadata: { description: 'Planta – São Paulo 🏠' } } } };
const original = ` \r\n${JSON.stringify(event, null, 2).replaceAll('\n', '\r\n')}\r\n\t`;
const secret = 'whsec_local_signature_test_only';
function signature(body = original) {
  const timestamp = Math.floor(Date.now() / 1000);
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}
function streamedRequest(body: string, signed = signature(), counters = { canceled: false }) {
  const bytes = new TextEncoder().encode(body);
  // One-byte chunks split multibyte characters as a real network may do.
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { if (offset === bytes.length) controller.close(); else controller.enqueue(bytes.slice(offset, ++offset)); },
    cancel() { counters.canceled = true; },
  });
  return new Request('https://roughbid.test/api/webhooks/stripe', { method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signed }, body: stream, duplex: 'half' } as RequestInit);
}
function fixture() {
  const deliveries: string[] = [];
  const grants = new Set<string>();
  const recorded = new Set<string>();
  const forbidden = async (): Promise<never> => { throw new Error('Unexpected external request or authentication'); };
  const dependencies: BillingEndpointDependencies = {
    config: { mode: 'test', productId: '', priceId: null, priceIds: {} }, webhookSecret: secret,
    authenticate: forbidden,
    stripe: { createCheckoutSession: forbidden, createPortalSession: forbidden },
    repository: { customerIdForUser: forbidden, processStripeEvent: async value => {
      const first = !recorded.has(value.id); recorded.add(value.id); return first;
    } },
    reconcileProjectPayment: async value => { deliveries.push(value.id); grants.add(value.id); },
  };
  const billing = createBillingEndpointHandler(dependencies);
  let forwarded: Uint8Array | undefined;
  const handler = createRawPostHandler(async request => {
    forwarded = new Uint8Array(await request.clone().arrayBuffer());
    return billing(request);
  });
  return { handler, deliveries, grants, recorded, forwarded: () => forwarded };
}

test('Stripe Web Request boundary preserves signed whitespace and split Unicode before billing verification', async () => {
  const f = fixture();
  const response = await f.handler(streamedRequest(original));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true, duplicate: false });
  assert.deepEqual(f.forwarded(), new TextEncoder().encode(original));
  assert.deepEqual(f.deliveries, [event.id]);
  assert.equal(f.grants.size, 1);
  // The boundary preserves retries; the existing repository/reconciliation
  // contract remains responsible for durable event idempotency.
  const duplicate = await f.handler(streamedRequest(original));
  assert.deepEqual(await duplicate.json(), { received: true, duplicate: true });
  assert.equal(f.grants.size, 1);
});

test('reserialized JSON or a one-byte change cannot pass the original signature or grant access', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  for (const altered of [JSON.stringify(JSON.parse(original)), original + ' ']) {
    const f = fixture();
    const response = await f.handler(streamedRequest(altered, signature(original)));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid Stripe webhook.' });
    assert.deepEqual(f.deliveries, []);
    assert.equal(f.grants.size, 0);
    assert.equal(f.recorded.size, 0);
  }
});

test('raw handler rejects chunked payloads over 2 MiB without Content-Length before billing', async () => {
  let forwarded = false;
  let canceled = false;
  let chunks = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { canceled = true; },
  });
  const request = new Request('https://roughbid.test/api/webhooks/stripe', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
  assert.equal(request.headers.has('content-length'), false);
  const response = await createRawPostHandler(async () => { forwarded = true; return new Response(); })(request);
  assert.equal(response.status, 413);
  assert.equal(forwarded, false);
  assert.equal(canceled, true);
  assert.ok(chunks <= 4, 'Stop reading once the bound is crossed.');
});

test('the exported Stripe route enforces size and method before dispatching the application', async () => {
  // These tests call the actual Vercel entry point without configured services.
  assert.equal((await POST(new Request('https://roughbid.test/api/webhooks/stripe'))).status, 405);
  assert.equal((await POST(new Request('https://roughbid.test/api/webhooks/stripe', {
    method: 'POST', headers: { 'content-length': String(2 * 1024 * 1024 + 1) }, body: 'x',
  }))).status, 413);
});

test('consumed or failed streams are rejected without reconstructing a parsed object', async () => {
  let forwarded = false;
  const handler = createRawPostHandler(async () => { forwarded = true; return new Response(); });
  const consumed = streamedRequest(original);
  await consumed.json();
  assert.equal((await handler(consumed)).status, 400);
  const broken = new Request('https://roughbid.test/api/webhooks/stripe', { method: 'POST',
    body: new ReadableStream({ start(controller) { controller.error(new Error('Interrupted stream')); } }), duplex: 'half' } as RequestInit);
  assert.equal((await handler(broken)).status, 400);
  assert.equal(forwarded, false);
});
