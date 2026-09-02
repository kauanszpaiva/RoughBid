import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeResourceOperation } from '../src/access/entitlements.ts';

test('authorization loads entitlements for the authenticated user', async () => {
  let requestedUser = '';
  await authorizeResourceOperation({
    async findForUser(userId) {
      requestedUser = userId;
      return [{
        startsAt: new Date('2026-09-01T00:00:00Z'),
        expiresAt: new Date('2026-11-01T00:00:00Z'),
      }];
    },
  }, 'user_123', 'plan-file:read', new Date('2026-09-02T00:00:00Z'));
  assert.equal(requestedUser, 'user_123');
});
