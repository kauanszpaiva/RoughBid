import test from 'node:test';
import assert from 'node:assert/strict';
import { fullTakeoffSpendInput } from '../app/src/utils/fullTakeoffApproval.ts';
const profile = { version: 'full-user-spend-v1' as const, policyId: 'profile', providers: [
  { provider: 'gemini', models: ['reviewed-model'], minimumUsd: 0.25, maximumUsd: 3, maximumCalls: 12 },
] };
test('blank, invalid, unchecked or unavailable user limits never enable a reading', () => {
  for (const value of ['', ' ', '-1', '0', '3.1', 'NaN', '1e2', '0.1234567']) assert.equal(fullTakeoffSpendInput(profile, { gemini: value }, true), null);
  assert.equal(fullTakeoffSpendInput(profile, { gemini: '1' }, false), null);
  assert.equal(fullTakeoffSpendInput(null, { gemini: '1' }, true), null);
  assert.deepEqual(fullTakeoffSpendInput(profile, { gemini: '1.25' }, true), { confirmed: true, policyId: 'profile', budgetsUsd: { gemini: 1.25 } });
});
