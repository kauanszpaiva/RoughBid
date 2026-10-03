import test from 'node:test';
import assert from 'node:assert/strict';
import { approveFullTakeoffSpend, fullTakeoffApprovalProfile, userApprovedFullRunLimits } from '../src/takeoff-v2/user-spend-approval.ts';
import { requireFullRunSpendLimits } from '../src/takeoff-v2/run-spend-policy.ts';
import { requireStageDeepPassConfig } from '../src/takeoff-v2/stage-config.ts';

import { consentTestEnv } from './helpers/full-takeoff-consent-fixture.ts';

test('only explicit numeric current-profile approval is accepted, never reported credit or a server ceiling alone', () => {
  const profile = fullTakeoffApprovalProfile(consentTestEnv);
  for (const input of [undefined, {}, { confirmed: false, policyId: profile.policyId, budgetsUsd: { gemini: 1 } },
    { confirmed: true, policyId: 'old-profile', budgetsUsd: { gemini: 1 } },
    ...[0, -1, '1', NaN, Infinity, 3.1, 0.1].map(amount => ({ confirmed: true, policyId: profile.policyId, budgetsUsd: { gemini: amount } })),
    { confirmed: true, policyId: profile.policyId, budgetsUsd: { gemini: 1, openai: 1 } }]) {
    assert.throws(() => approveFullTakeoffSpend(input, profile, 'owner'));
  }
  assert.doesNotMatch(JSON.stringify(profile), /unit-gemini-credential/);
});

test('user limits are immutable request-bound reductions of policy; new provider/model profile cannot inherit consent', () => {
  const profile = fullTakeoffApprovalProfile(consentTestEnv);
  const limits = requireFullRunSpendLimits(consentTestEnv, requireStageDeepPassConfig(consentTestEnv));
  const input = { confirmed: true, policyId: profile.policyId, budgetsUsd: { gemini: 1 } };
  const approval = approveFullTakeoffSpend(input, profile, 'owner');
  assert.deepEqual(approval, approveFullTakeoffSpend(input, profile, 'owner'), 'HTTP retry has stable authorization identity');
  const saved = userApprovedFullRunLimits(approval, profile, limits);
  assert.equal(saved[0]!.approvedUsd, 1);
  assert.equal(saved[0]!.maximumCalls, 12);
  assert.equal(saved[0]!.approvalRef, 'user-job-v1:owner');
  assert.equal(limits[0]!.approvedUsd, 3);
  assert.throws(() => userApprovedFullRunLimits(undefined, profile, limits));
  assert.throws(() => userApprovedFullRunLimits({ ...approval, providers: [{ ...approval.providers[0]!, models: ['unapproved-model'] }] }, profile, limits));
  const changed = fullTakeoffApprovalProfile({ ...consentTestEnv, TAKEOFF_V2_STAGE_CLASSIFICATION_MAX_OUTPUT_TOKENS: '4096' });
  assert.notEqual(profile.policyId, changed.policyId);
  assert.throws(() => userApprovedFullRunLimits(approval, changed, limits));
});

test('automatic geometry cannot silently add another vendor bill to model-only user consent', () => {
  assert.throws(() => fullTakeoffApprovalProfile({ ...consentTestEnv, GEOMETRY_PROVIDER_ENABLED: 'true', TAKEOFF_V2_KAMAI_ENABLED: 'true' }), /separate per-job/);
});

test('persisted JSONB consent starts with the same authorization regardless of object key order', () => {
  const profile = fullTakeoffApprovalProfile(consentTestEnv);
  const limits = requireFullRunSpendLimits(consentTestEnv, requireStageDeepPassConfig(consentTestEnv));
  const approval = approveFullTakeoffSpend({ confirmed: true, policyId: profile.policyId, budgetsUsd: { gemini: 1 } }, profile, 'owner');
  const persisted = { ...approval, providers: approval.providers.map(({ models, provider, approvedUsd }) => ({ models, provider, approvedUsd })) };
  assert.notEqual(JSON.stringify(approval.providers), JSON.stringify(persisted.providers), 'fixture models PostgreSQL JSONB key order');
  assert.deepEqual(userApprovedFullRunLimits(persisted, profile, limits), userApprovedFullRunLimits(approval, profile, limits));
  for (const providers of [
    [{ ...persisted.providers[0]!, provider: 'openai' }],
    [{ ...persisted.providers[0]!, approvedUsd: 4 }],
    [{ ...persisted.providers[0]!, models: ['unapproved-model'] }],
    [{ ...persisted.providers[0]!, arbitrary: true }],
  ]) assert.throws(() => userApprovedFullRunLimits({ ...persisted, providers } as typeof approval, profile, limits));
});

test('displayed minimum covers the existing company reservation and never changes that policy', () => {
  const profile = fullTakeoffApprovalProfile({ ...consentTestEnv, TAKEOFF_V2_CALL_RESERVATION_USD: '2.5' });
  assert.equal(profile.providers[0]!.minimumUsd, 2.5);
  assert.throws(() => approveFullTakeoffSpend({ confirmed: true, policyId: profile.policyId, budgetsUsd: { gemini: 1 } }, profile, 'owner'));
  assert.throws(() => fullTakeoffApprovalProfile({ ...consentTestEnv, TAKEOFF_V2_CALL_RESERVATION_USD: '' }));
  assert.throws(() => fullTakeoffApprovalProfile({ ...consentTestEnv, TAKEOFF_V2_CALL_RESERVATION_USD: '4' }));
});
