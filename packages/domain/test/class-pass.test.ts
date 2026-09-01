import test from 'node:test';
import assert from 'node:assert/strict';
import { createClassPassWindow, isClassPassActive } from '../src/index.ts';

test('createClassPassWindow creates exactly 60 days with no payment requirement', () => {
  const pass = createClassPassWindow(new Date('2026-09-10T12:00:00.000Z'));
  assert.equal(pass.startsAt.toISOString(), '2026-09-10T12:00:00.000Z');
  assert.equal(pass.expiresAt.toISOString(), '2026-11-09T12:00:00.000Z');
  assert.equal(pass.requiresPaymentMethod, false);
});

test('isClassPassActive excludes the exact expiration instant', () => {
  const pass = createClassPassWindow(new Date('2026-09-10T12:00:00.000Z'));
  assert.equal(isClassPassActive(pass, new Date('2026-09-10T12:00:00.000Z')), true);
  assert.equal(isClassPassActive(pass, new Date('2026-11-09T11:59:59.999Z')), true);
  assert.equal(isClassPassActive(pass, new Date('2026-11-09T12:00:00.000Z')), false);
});
