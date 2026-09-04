import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccessWindow, isAccessWindowActive } from '../src/index.ts';

test('createAccessWindow creates configured access with no payment requirement', () => {
  const access = createAccessWindow(new Date('2026-09-10T12:00:00.000Z'), 45);
  assert.equal(access.startsAt.toISOString(), '2026-09-10T12:00:00.000Z');
  assert.equal(access.expiresAt.toISOString(), '2026-10-25T12:00:00.000Z');
  assert.equal(access.requiresPaymentMethod, false);
});

test('isAccessWindowActive excludes the exact expiration instant', () => {
  const access = createAccessWindow(new Date('2026-09-10T12:00:00.000Z'), 45);
  assert.equal(isAccessWindowActive(access, new Date('2026-09-10T12:00:00.000Z')), true);
  assert.equal(isAccessWindowActive(access, new Date('2026-10-25T11:59:59.999Z')), true);
  assert.equal(isAccessWindowActive(access, new Date('2026-10-25T12:00:00.000Z')), false);
});
