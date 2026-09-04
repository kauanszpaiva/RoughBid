import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../migrations/0010_free_trial_entitlement.sql', import.meta.url), 'utf8');

test('RoughBid free trial grants standalone access without PrimeBid or 60-day terms', () => {
  assert.match(sql, /roughbid_free_trial/i);
  assert.match(sql, /interval '14 days'/i);
  assert.match(sql, /public\.entitlements/i);
  assert.doesNotMatch(sql, /PrimeBid/i);
  assert.doesNotMatch(sql, /60\s+days/i);
});
