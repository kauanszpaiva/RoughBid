import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectPayments } from '../src/billing/project-payments.ts';

test('Stripe checkout reconciliation normalizes currency before the database RPC', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: true, error: null };
    },
  };

  const payments = new ProjectPayments(db as never, {});
  await payments.reconcile({
    id: 'evt-uppercase-currency',
    type: 'checkout.session.completed',
    livemode: false,
    data: {
      object: {
        id: 'cs_test',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_test',
        amount_total: 500,
        currency: 'USD',
        metadata: { roughbid_quote_id: 'quote-1' },
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.fn, 'confirm_project_reading_payment');
  assert.equal(calls[0]?.args.p_currency, 'usd');
});
