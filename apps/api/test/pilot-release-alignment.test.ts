import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PILOT_MODEL, PILOT_RESERVATION_CENTS } from '../src/ai-plan/pilot-reader.ts';

const migration = readFileSync(
  new URL('../../../supabase/migrations/0034_pilot_budget_and_model_alignment.sql', import.meta.url),
  'utf8',
);

test('pilot release is pinned to the production-verified provider model', () => {
  assert.equal(PILOT_MODEL, 'gemini-3.8-flash');
  assert.match(migration, /p_model is distinct from 'gemini-3\.8-flash'/);
  assert.doesNotMatch(migration, /gemini-2\.5-flash/);
});

test('pilot release enforces the approved aggregate cohort ceiling before provider work', () => {
  assert.equal(PILOT_RESERVATION_CENTS, 25);
  assert.match(migration, /reserved_cents > 10000/);
  assert.match(migration, /budget_cents = 10000/);
  assert.match(migration, /budget_cents between 0 and 10000/);
  assert.match(migration, /c\.reserved_cents\+25>c\.budget_cents/);
});
