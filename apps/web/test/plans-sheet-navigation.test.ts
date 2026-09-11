import test from 'node:test';
import assert from 'node:assert/strict';
import { fallbackSheetLabel } from '../app/src/features/plans/types.ts';

test('physical page fallback labels are neutral and zero-padded', () => {
  assert.equal(fallbackSheetLabel(1), 'Page 01');
  assert.equal(fallbackSheetLabel(23), 'Page 23');
  assert.doesNotMatch(fallbackSheetLabel(1), /^A\d/);
});
