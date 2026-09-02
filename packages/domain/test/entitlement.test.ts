import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertEntitled,
  EntitlementRequiredError,
  hasActiveEntitlement,
} from '../src/index.ts';

const active = {
  startsAt: new Date('2026-09-01T00:00:00.000Z'),
  expiresAt: new Date('2026-11-01T00:00:00.000Z'),
};

test('active entitlements gate project, estimate, and plan file operations', () => {
  const at = new Date('2026-09-15T00:00:00.000Z');
  assert.equal(hasActiveEntitlement([active], at), true);
  for (const operation of ['project:write', 'estimate:read', 'plan-file:write'] as const) {
    assert.doesNotThrow(() => assertEntitled(operation, [active], at));
  }
});

test('missing, expired, future, and revoked entitlements are rejected', () => {
  const at = new Date('2026-11-01T00:00:00.000Z');
  assert.equal(hasActiveEntitlement([], at), false);
  assert.throws(
    () => assertEntitled('project:read', [active], at),
    (error) => error instanceof EntitlementRequiredError && error.code === 'ENTITLEMENT_REQUIRED',
  );
  assert.equal(hasActiveEntitlement([{ ...active, revokedAt: new Date() }], new Date('2026-09-15')), false);
});
