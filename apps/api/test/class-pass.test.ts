import test from 'node:test';
import assert from 'node:assert/strict';
import { grantClassPass, type ClassPassGrant } from '../src/class-pass/grant.ts';

test('grant persists a Stripe-independent 60-day pass then triggers welcome email', async () => {
  const events: string[] = [];
  let persisted: ClassPassGrant | undefined;
  const result = await grantClassPass({
    userId: 'user_123',
    email: 'student@example.com',
    appUrl: 'https://app.roughbid.com',
  }, {
    now: () => new Date('2026-09-02T10:30:00.000Z'),
    store: { async insert(grant) { events.push('insert'); persisted = grant; return grant; } },
    async sendWelcomeEmail(input) {
      events.push('email');
      assert.deepEqual(input, { to: 'student@example.com', appUrl: 'https://app.roughbid.com' });
    },
  });

  assert.deepEqual(events, ['insert', 'email']);
  assert.equal(result, persisted);
  assert.equal(result.startsAt.toISOString(), '2026-09-02T10:30:00.000Z');
  assert.equal(result.expiresAt.toISOString(), '2026-11-01T10:30:00.000Z');
  assert.equal(result.paymentProvider, null);
  assert.equal(result.paymentMethodRequired, false);
  assert.equal('stripeCustomerId' in result, false);
});
