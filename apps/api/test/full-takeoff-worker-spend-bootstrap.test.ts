import test from 'node:test';
import assert from 'node:assert/strict';
import { createFullTakeoffRunSpendPolicy } from '../src/takeoff-v2/paid-access.ts';
import { approveFullTakeoffSpend, fullTakeoffApprovalProfile } from '../src/takeoff-v2/user-spend-approval.ts';
import { buildPaidFullContract, hashPaidFullContract } from '../src/billing/full-takeoff-pricing.ts';
import { multiproviderEnv } from './full-takeoff-multiprovider.test.ts';
import { pricingEnv, testManifest } from './full-takeoff-pricing.test.ts';

const complimentary = JSON.stringify({ gemini: { approvedUsd: 5, maximumCalls: 100, approvalRef: 'unit-existing-complimentary' } });

test('paid worker bootstraps without complimentary budgets and uses only the saved multiprovider contract', () => {
  for (const legacy of [undefined, '', 'not-json', complimentary]) {
    const env = { ...multiproviderEnv(), TAKEOFF_V2_RUN_SPEND_LIMITS_JSON: legacy };
    const manifest = testManifest();
    const contract = buildPaidFullContract({ manifest: testManifest(), membership: 'standard', env,
      companyPolicy: { callReservationUsd: 2.5, spendCapUsd: 25 } });
    manifest.paidAuthorization = { approvedBy: 'buyer', quoteId: 'saved-paid-quote', paymentRevision: 1,
      contractHash: hashPaidFullContract(contract), contract };
    const prepare = createFullTakeoffRunSpendPolicy(env);
    assert.deepEqual(prepare(manifest), contract.providers.map(provider => ({ ...provider,
      approvalRef: 'paid-full-v2:saved-paid-quote:1' })));
    assert.equal(prepare(manifest).length, 5);
    assert.throws(() => prepare(testManifest()), /budgets|budget for|bounded .* call/,
      'an unpaid run still requires every configured provider ceiling');
    assert.equal(env.TAKEOFF_V2_RUN_SPEND_LIMITS_JSON, legacy, 'bootstrap never expands complimentary limits');
  }
});

test('unpaid preparation still requires explicit current consent and preserves five dollars / one hundred calls', () => {
  const env = { ...pricingEnv(), TAKEOFF_V2_RUN_SPEND_LIMITS_JSON: complimentary };
  const prepare = createFullTakeoffRunSpendPolicy(env);
  const manifest = testManifest();
  assert.throws(() => prepare(manifest), /Explicit user approval/);
  const profile = fullTakeoffApprovalProfile(env);
  manifest.spendApproval = approveFullTakeoffSpend({ confirmed: true, policyId: profile.policyId,
    budgetsUsd: { gemini: 5 } }, profile, 'owner');
  assert.deepEqual(prepare(manifest), [{ provider: 'gemini', models: ['gemini-3.8-flash'], approvedUsd: 5,
    maximumCalls: 100, approvalRef: 'user-job-v1:owner' }]);
  manifest.spendApproval.providers[0]!.approvedUsd = 6;
  assert.throws(() => prepare(manifest), /valid gemini spending limit/);
});

test('paid authorization failures cannot fall back to valid complimentary consent', () => {
  const env = { ...pricingEnv(), TAKEOFF_V2_RUN_SPEND_LIMITS_JSON: complimentary };
  const manifest = testManifest();
  const profile = fullTakeoffApprovalProfile(env);
  manifest.spendApproval = approveFullTakeoffSpend({ confirmed: true, policyId: profile.policyId,
    budgetsUsd: { gemini: 5 } }, profile, 'owner');
  const contract = buildPaidFullContract({ manifest: testManifest(), membership: 'standard', env });
  manifest.paidAuthorization = { approvedBy: 'buyer', quoteId: 'saved-paid-quote', paymentRevision: 1,
    contractHash: 'wrong-hash', contract };
  assert.throws(() => createFullTakeoffRunSpendPolicy(env)(manifest), /saved plan revision/);
});

test('worker bootstrap retains exact technical capability and model-attestation checks', () => {
  const env = multiproviderEnv();
  assert.throws(() => createFullTakeoffRunSpendPolicy({ ...env, TAKEOFF_V2_MODEL_ATTESTATIONS_JSON: '{}' }));
  assert.throws(() => createFullTakeoffRunSpendPolicy({ ...env, TAKEOFF_V2_STAGE_CLASSIFICATION_MODEL: 'unverified-model' }));
});
