import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_EVIDENCE_PASSES } from '../src/takeoff-v2/stage-config.ts';
import { buildPaidFullContract, hashPaidFullContract, validatePaidFullContract } from '../src/billing/full-takeoff-pricing.ts';
import type { PlanSetManifest } from '../src/takeoff-v2/types.ts';
export function pricingEnv(): Record<string, string> {
  return { PAID_FULL_ENABLED: 'true', STRIPE_MODE: 'live', PAID_FULL_PRICING_VERSION: 'unit-reviewed-v1',
    PAID_FULL_OVERHEAD_BASE_CENTS: '0', PAID_FULL_OVERHEAD_PAGE_CENTS: '0', PROJECT_PAYMENT_FIXED_CENTS: '0', PROJECT_PAYMENT_FEE_BPS: '0',
    PAID_FULL_MAXIMUM_RESERVE_USD: '8000', PAID_FULL_MAXIMUM_CALLS: '3200', TAKEOFF_V2_CALL_RESERVATION_USD: '2.5',
    TAKEOFF_V2_ENABLED: 'true', TAKEOFF_V2_WORKER_ENABLED: 'true', TAKEOFF_V2_STAGE_PROVIDER_ENABLED: 'true',
    TAKEOFF_V2_SCHEMA_VERSION: 'takeoff-v2-foundation-v1', TAKEOFF_V2_REGIONAL_REVIEW_ENABLED: 'true', TAKEOFF_V2_REGION_GRID: '2',
    GEMINI_API_KEY: 'unit-not-a-real-key', GEMINI_MODEL: 'gemini-3.8-flash',
    TAKEOFF_V2_MODEL_ATTESTATIONS_JSON: JSON.stringify({ 'gemini-3.8-flash': { accountVerified: true, compatibilityVerified: true,
      priceVersion: 'unit-standard-v1', maximumCallCostUsd: 2.5 } }),
    ...Object.fromEntries(AI_EVIDENCE_PASSES.flatMap(pass => [[`TAKEOFF_V2_STAGE_${pass.toUpperCase()}_ENABLED`, 'true'],
      [`TAKEOFF_V2_STAGE_${pass.toUpperCase()}_PROVIDER`, 'gemini']])) };
}
export function testManifest(pages = 1): PlanSetManifest {
  return { fileSha256: 'a'.repeat(64), physicalPageCount: pages, sheets: Array.from({ length: pages }, (_, i) => ({
    physicalPageNumber: i + 1, pageSha256: 'b'.repeat(64), widthPoints: 612, heightPoints: 792, orientation: 'portrait',
    rotationDegrees: 0, contentKind: 'vector', textQuality: 'good', status: 'review_required', statusReason: 'Synthetic test' })) };
}
const now = Date.parse('2026-10-03T00:00:00Z');
test('complete scope reserves all 16 calls/page, prices economic upper cost and applies revenue margin', () => {
  const contract = buildPaidFullContract({ manifest: testManifest(2), membership: 'standard', env: pricingEnv(), now });
  assert.equal(contract.maximumCalls, 32);
  assert.equal(contract.providers[0]!.approvedUsd, 80);
  assert.equal(contract.pricing.providerCostUpperBoundUsd, 33.28);
  assert.equal(contract.pricing.costCents, 3328);
  assert.equal(contract.pricing.amountCents, 6656);
  assert.equal(contract.pricing.marginBps, 5000);
  assert.equal(contract.executionPolicy, 'one-durable-run-budget-wait-no-uncertain-replay');
});
test('paid scope does not inherit the complimentary five-dollar ceiling', () => {
  const env = { ...pricingEnv(), TAKEOFF_V2_RUN_SPEND_LIMITS_JSON: '{"gemini":{"approvedUsd":5}}' };
  assert.equal(buildPaidFullContract({ manifest: testManifest(), membership: 'standard', env, now }).providers[0]!.approvedUsd, 40);
});

test('waiting across daily windows preserves the whole-run allowance and invalidates the old consent contract', () => {
  const env = pricingEnv();
  const contract = buildPaidFullContract({ manifest: testManifest(2), membership: 'standard', env, now });
  assert.equal(contract.pricing.operatingReserveUsd, 80);
  assert.equal(contract.maximumCalls, 32);
  assert.equal(contract.providers[0]!.approvedUsd, 80);
  assert.equal(contract.pricing.amountCents, 6656);
  const previous = { ...contract, executionPolicy: 'one-durable-run-no-uncertain-replay' } as unknown as typeof contract;
  assert.notEqual(hashPaidFullContract(previous), hashPaidFullContract(contract));
  assert.throws(() => validatePaidFullContract(previous, env, now), /changed/);
});
test('missing tariff policy, expired tariff, incomplete scope and insufficient caps fail closed', () => {
  for (const [key, value] of Object.entries({ PAID_FULL_ENABLED: 'false', STRIPE_MODE: 'test', PAID_FULL_PRICING_VERSION: '',
    PAID_FULL_OVERHEAD_BASE_CENTS: '', PAID_FULL_MAXIMUM_RESERVE_USD: '5', PAID_FULL_MAXIMUM_CALLS: '15',
    TAKEOFF_V2_REGIONAL_REVIEW_ENABLED: 'false', TAKEOFF_V2_REGION_GRID: '3', TAKEOFF_V2_STAGE_RISK_REVIEW_ENABLED: 'false',
    GEOMETRY_PROVIDER_ENABLED: 'true', GEMINI_MODEL: 'gemini-3.1-pro-preview' })) {
    assert.throws(() => buildPaidFullContract({ manifest: testManifest(), membership: 'standard', env: { ...pricingEnv(), [key]: value }, now }), key);
  }
  assert.throws(() => buildPaidFullContract({ manifest: testManifest(), membership: 'standard', env: pricingEnv(), now: Date.parse('2027-01-01') }), /expired/);
  const rotated = testManifest(); rotated.sheets[0]!.rotationDegrees = 45 as 90;
  assert.throws(() => buildPaidFullContract({ manifest: rotated, membership: 'standard', env: pricingEnv(), now }), /orientation/);
  const omitted = testManifest(2); omitted.sheets.pop();
  assert.throws(() => buildPaidFullContract({ manifest: omitted, membership: 'standard', env: pricingEnv(), now }));
});

test('right-angle rotations retain every physical page, immutable orientation and all sixteen calls per page',()=>{
  const manifest=testManifest(4);
  for(const [index,rotation] of [0,90,180,270].entries())manifest.sheets[index]!.rotationDegrees=rotation as 0|90|180|270;
  const contract=buildPaidFullContract({manifest,membership:'standard',env:pricingEnv(),now});
  assert.equal(contract.maximumCalls,64);assert.equal(contract.pricing.operatingReserveUsd,160);
  assert.deepEqual(contract.manifest.sheets.map(sheet=>sheet.rotationDegrees),[0,90,180,270]);
  assert.deepEqual(contract.manifest.sheets.map(sheet=>sheet.pageSha256),manifest.sheets.map(sheet=>sheet.pageSha256));
});
test('immutable contract survives JSONB ordering but rejects price, scope or runtime profile changes', () => {
  const env = pricingEnv(); const contract = buildPaidFullContract({ manifest: testManifest(), membership: 'standard', env, now });
  const reordered = Object.fromEntries(Object.entries(contract).reverse()) as typeof contract;
  assert.equal(hashPaidFullContract(reordered), hashPaidFullContract(contract));
  assert.equal(validatePaidFullContract(reordered, env, now).policyId, contract.policyId);
  for (const changed of [{ ...contract, maximumCalls: 15 }, { ...contract, pricing: { ...contract.pricing, amountCents: 1 } }]) {
    assert.throws(() => validatePaidFullContract(changed, env, now), /changed/);
  }
  assert.throws(() => validatePaidFullContract(contract, { ...env, TAKEOFF_V2_PROVIDER_MAX_OUTPUT_TOKENS: '4096' }, now), /changed/);
  assert.equal(hashPaidFullContract(validatePaidFullContract(contract, { ...env, GEMINI_API_KEY: 'another-unit-key' }, now)), hashPaidFullContract(contract));
});
