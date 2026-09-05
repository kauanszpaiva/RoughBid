import test from 'node:test';
import assert from 'node:assert/strict';
import { grantWorkspaceAccess, type AccessGrant } from '../src/access-grants/grant.ts';

test('grant persists Stripe-independent workspace access then triggers welcome email', async () => {
  const events: string[] = [];
  let persisted: AccessGrant | undefined;
  const result = await grantWorkspaceAccess({
    userId: 'user_123',
    email: 'estimator@example.com',
    appUrl: 'https://app.roughbid.com',
    durationDays: 45,
  }, {
    now: () => new Date('2026-09-02T10:30:00.000Z'),
    store: { async insert(grant) { events.push('insert'); persisted = grant; return grant; } },
    async sendWelcomeEmail(input) {
      events.push('email');
      assert.deepEqual(input, { to: 'estimator@example.com', appUrl: 'https://app.roughbid.com' });
    },
  });

  assert.deepEqual(events, ['insert', 'email']);
  assert.equal(result, persisted);
  assert.equal(result.startsAt.toISOString(), '2026-09-02T10:30:00.000Z');
  assert.equal(result.expiresAt.toISOString(), '2026-10-17T10:30:00.000Z');
  assert.equal(result.paymentProvider, null);
  assert.equal(result.paymentMethodRequired, false);
  assert.equal('stripeCustomerId' in result, false);
});
