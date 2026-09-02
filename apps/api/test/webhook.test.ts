import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { StripeWebhookHandler, verifyStripeSignature } from '../src/billing/webhook.ts';

const secret = 'whsec_test_only';
const timestamp = 1_800_000_000;
const body = JSON.stringify({ id: 'evt_123', type: 'customer.subscription.updated', data: {} });
const signature = (payload = body) => `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')}`;

test('Stripe signatures reject tampering, wrong secrets, and stale timestamps', () => {
  assert.doesNotThrow(() => verifyStripeSignature(body, signature(), secret, timestamp * 1000));
  assert.throws(() => verifyStripeSignature(`${body} `, signature(), secret, timestamp * 1000), /invalid stripe signature/i);
  assert.throws(() => verifyStripeSignature(body, signature(), 'wrong', timestamp * 1000), /invalid stripe signature/i);
  assert.throws(() => verifyStripeSignature(body, signature(), secret, (timestamp + 301) * 1000), /tolerance/i);
});

test('Stripe events are processed exactly once and failures remain retryable', async () => {
  const handled: string[] = [];
  const handler = new StripeWebhookHandler(secret, (event) => handled.push(event.id));
  assert.deepEqual(await handler.handle(body, signature(), timestamp * 1000), { duplicate: false });
  assert.deepEqual(await handler.handle(body, signature(), timestamp * 1000), { duplicate: true });
  assert.deepEqual(handled, ['evt_123']);

  let attempts = 0;
  const retryable = new StripeWebhookHandler(secret, () => {
    if (++attempts === 1) throw new Error('temporary failure');
  });
  await assert.rejects(retryable.handle(body, signature(), timestamp * 1000), /temporary/);
  assert.deepEqual(await retryable.handle(body, signature(), timestamp * 1000), { duplicate: false });
  assert.equal(attempts, 2);
});

test('concurrent delivery cannot process the same Stripe event twice', async () => {
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const handler = new StripeWebhookHandler(secret, async () => {
    calls += 1;
    await blocked;
  });
  const first = handler.handle(body, signature(), timestamp * 1000);
  const second = handler.handle(body, signature(), timestamp * 1000);
  release();
  assert.deepEqual(await Promise.all([first, second]), [{ duplicate: false }, { duplicate: true }]);
  assert.equal(calls, 1);
});
