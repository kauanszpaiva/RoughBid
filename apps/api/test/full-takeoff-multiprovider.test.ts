import test from 'node:test';
import assert from 'node:assert/strict';
import { maximumTokenCostUsd } from '../src/billing/provider-cost-bound.ts';
import { buildPaidFullContract, hashPaidFullContract, validatePaidFullContract, type PaidFullOperationContract } from '../src/billing/full-takeoff-pricing.ts';
import { openPaidFullCheckout, requirePaidFullBatchScheduling } from '../src/billing/full-takeoff-payments.ts';
import { AI_EVIDENCE_PASSES, STAGE_MODEL_REGISTRY } from '../src/takeoff-v2/stage-config.ts';
import { pricingEnv, testManifest } from './full-takeoff-pricing.test.ts';

const now = Date.parse('2026-10-03T00:00:00Z');
const policy = { callReservationUsd: 2.5, spendCapUsd: 25 };
/** All values here are synthetic fixtures, not provider price assertions. */
export function multiproviderEnv(): Record<string, string> {
  const env = { ...pricingEnv(), TAKEOFF_V2_TRANSPORT: 'bridge', PROVIDER_BRIDGE_ENABLED: 'true',
    TAKEOFF_V2_OPENAI_REQUEST_POLICY: 'explicit-cache-default-v1',
    KIMI_PRIVATE_PLAN_DATA_APPROVED: 'true', DEEPSEEK_PRIVATE_PLAN_DATA_APPROVED: 'true',
    PAID_FULL_PRICING_VERSION: 'unit-multiprovider-v2', PAID_FULL_OVERHEAD_BASE_POLICY: 'purchase' };
  const modelByPass = ['gemini-3.8-flash', 'claude-opus-5-5', 'kimi-k3', 'gpt-6-astra', 'deepseek-flash', 'gemini-3.8-flash', 'claude-fable-5-1'] as const;
  const hosts = { gemini: 'ai.google.dev', openai: 'developers.openai.com', claude: 'platform.claude.com', kimi: 'platform.kimi.ai', deepseek: 'api-docs.deepseek.com' };
  const routes: Record<string, any> = {}, attestations: Record<string, any> = {};
  for (const [index, pass] of AI_EVIDENCE_PASSES.entries()) {
    const model = modelByPass[index]!, { provider, inputKind } = STAGE_MODEL_REGISTRY[model];
    const effort = provider === 'gemini' ? 'high' : 'max';
    const maximumCallCostUsd = provider === 'openai' ? 24.52 : provider === 'claude' ? 6 : provider === 'kimi' ? 3 : 1.04;
    const prefix = `TAKEOFF_V2_STAGE_${pass.toUpperCase()}`;
    env[`${prefix}_PROVIDER`] = provider; env[`${prefix}_MODEL`] = model;
    env[`${prefix}_REASONING_EFFORT`] = effort; env[`${prefix}_MAX_OUTPUT_TOKENS`] = '64000';
    attestations[model] = { accountVerified: true, compatibilityVerified: true, priceVersion: 'unit-test-tariff', maximumCallCostUsd };
    routes[pass] = { provider, model, inputKind, reasoningEffort: effort, maxOutputTokens: 64000, timeoutMs: 120000,
      priceVersion: 'unit-test-tariff', maximumCallCostUsd,
      ...(provider === 'openai' ? { requestPolicy: 'explicit-cache-default-v1' } : {}),
      tariff: { inputUsdPerMillion: provider === 'openai' ? 20 : .5, outputUsdPerMillion: provider === 'openai' ? 75 : 1,
        inputTokenLimit: provider === 'openai' ? 1050000 : 1000000, outputTokenLimit: 64000,
        ...(provider === 'openai' ? { combinedContextTokenLimit: 1050000 } : {}), additionalRequestUsd: 0,
        source: `https://${hosts[provider]}/synthetic-fixture`, verifiedAt: '2026-10-02T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z',
        standardUncached: true, reasoningIncluded: true, maximumAcceptedInput: true } };
  }
  env.TAKEOFF_V2_MODEL_ATTESTATIONS_JSON = JSON.stringify(attestations);
  env.PAID_FULL_PROFILE_JSON = JSON.stringify({ version: 'full-processing-v2', routes });
  return env;
}
const build = (env = multiproviderEnv(), pages = 1, companyPolicy = policy) => {
  const result = buildPaidFullContract({ manifest: testManifest(pages), membership: 'standard', env, companyPolicy, now });
  assert.equal(result.version, 'paid-full-v2'); return result as PaidFullOperationContract;
};

test('shared token bound maximizes both independent and combined context constraints', () => {
  const tariff = { inputUsdPerMillion: 20, outputUsdPerMillion: 75, inputTokenLimit: 1050000, outputTokenLimit: 64000, additionalRequestUsd: 0 };
  assert.equal(maximumTokenCostUsd(tariff), 25.8);
  assert.equal(maximumTokenCostUsd({ ...tariff, combinedContextTokenLimit: 1050000 }), 24.52);
  assert.equal(maximumTokenCostUsd({ ...tariff, inputUsdPerMillion: 75, outputUsdPerMillion: 20, combinedContextTokenLimit: 1050000 }), 78.75);
  assert.equal(maximumTokenCostUsd({ ...tariff, combinedContextTokenLimit: 1050000, additionalRequestUsd: .1 }), 24.62);
  for (const changed of [{ inputTokenLimit: 0 }, { outputUsdPerMillion: NaN }, { combinedContextTokenLimit: -1 }, { additionalRequestUsd: -1 }]) {
    assert.throws(() => maximumTokenCostUsd({ ...tariff, ...changed }));
  }
});

test('Full v2 holds each exact operation above the base and sums all providers without a run ceiling', () => {
  const env = { ...multiproviderEnv(), TAKEOFF_V2_CALL_RESERVATION_USD: '0.01', TAKEOFF_V2_RUN_SPEND_LIMITS_JSON: '{"gemini":{"approvedUsd":5,"maximumCalls":100}}' };
  const c = build(env, 2);
  assert.equal(c.maximumCalls, 32); assert.equal(c.pricing.callReservationUsd, 2.5);
  assert.equal(c.operations.find(op => op.provider === 'openai')!.reservationUsd, 24.52);
  assert.equal(c.operations.find(op => op.provider === 'gemini')!.reservationUsd, 2.5);
  assert.equal(c.operations.find(op => op.provider === 'claude')!.reservationUsd, 6);
  assert.equal(c.providers.length, 5);
  assert.equal(c.pricing.operatingReserveUsd, 142.04);
  assert.equal(c.pricing.providerCostUpperBoundUsd, 115.76);
  for (const provider of c.providers) {
    const ops = c.operations.filter(op => op.provider === provider.provider);
    assert.equal(provider.maximumCalls, ops.length);
    assert.equal(Math.round(provider.approvedUsd * 1e6), ops.reduce((sum, op) => sum + Math.round(op.reservationUsd * 1e6), 0));
  }
  assert.deepEqual(c.operations.slice(0, 4).map(op => op.key), ['page:1:classification:whole', 'page:2:classification:whole', 'page:1:legends_schedules:whole', 'page:2:legends_schedules:whole']);
  assert.deepEqual(c.operations.slice(4, 8).map(op => op.regionKey), ['r1c1g2', 'r1c2g2', 'r2c1g2', 'r2c2g2']);
  assert.equal(c.operations.filter(op => op.physicalPageNumber === 2).length, 16);
  assert.equal(new Set(c.operations.map(op => op.key)).size, c.operations.length);
  assert.equal(JSON.stringify(c).includes('unit-not-a-real-key'), false);
});

test('Full v2 applies the existing membership, overhead and one payment fee to the summed scope', () => {
  const env = { ...multiproviderEnv(), PROJECT_PAYMENT_FIXED_CENTS: '30', PROJECT_PAYMENT_FEE_BPS: '290',
    PAID_FULL_OVERHEAD_BASE_CENTS: '100', PAID_FULL_OVERHEAD_PAGE_CENTS: '25' };
  const c = build(env, 2);
  assert.equal(c.pricing.overheadBaseCents, 100);
  assert.equal(c.pricing.overheadPageCents, 25);
  assert.equal(c.pricing.overheadBasePolicy, 'purchase');
  assert.equal(c.pricing.costCents, 11726);
  assert.equal(c.pricing.amountCents, Math.ceil((11726 + 30) * 10000 / (10000 - 5000 - 290)));
});

test('Full v2 rejects missing, cheap, expired, unsupported and over-company-cap profiles', () => {
  assert.throws(() => build({ ...multiproviderEnv(), PAID_FULL_PROFILE_JSON: '' }));
  assert.throws(() => build({ ...multiproviderEnv(), PAID_FULL_OVERHEAD_BASE_POLICY: '' }), /overhead policy/);
  assert.throws(() => buildPaidFullContract({ manifest: testManifest(), membership: 'standard', env: multiproviderEnv(), now }), /company policy/);
  assert.throws(() => build(multiproviderEnv(), 1, { ...policy, spendCapUsd: 20 }), /individual/);
  assert.throws(() => build({ ...multiproviderEnv(), TAKEOFF_V2_OPENAI_REQUEST_POLICY: '' }), /request policy/);
  assert.throws(() => build({ ...multiproviderEnv(), TAKEOFF_V2_TRANSPORT: 'direct' }));
  for (const change of [(r: any) => { r.reconciliation.tariff.combinedContextTokenLimit = undefined; },
    (r: any) => { r.classification.tariff.source = 'https://not-primary.example/pricing'; },
    (r: any) => { r.classification.tariff.source = 'https://ai.google.dev.attacker.example/pricing'; },
    (r: any) => { r.classification.tariff.reasoningIncluded = false; },
    (r: any) => { r.classification.tariff.maximumAcceptedInput = false; },
    (r: any) => { r.classification.tariff.standardUncached = false; },
    (r: any) => { r.classification.tariff.verifiedAt = '2028-01-01'; },
    (r: any) => { r.classification.tariff.expiresAt = '2026-10-01'; },
    (r: any) => { r.risk_review = undefined; },
    (r: any) => { r.classification.maxOutputTokens = 4096; },
    (r: any) => { r.classification.tariff.outputTokenLimit = 4096; }]) {
    const env = multiproviderEnv(), raw = JSON.parse(env.PAID_FULL_PROFILE_JSON!); change(raw.routes);
    env.PAID_FULL_PROFILE_JSON = JSON.stringify(raw); assert.throws(() => build(env));
  }
});

test('immutable v2 hashes operations/settings/tariffs while v1 never adopts a new profile', () => {
  const env = multiproviderEnv(), c = build(env);
  assert.equal(hashPaidFullContract(validatePaidFullContract(c, env, now)), hashPaidFullContract(c));
  for (const change of [(x: PaidFullOperationContract) => { x.operations[0]!.reservationUsd = 1; },
    (x: PaidFullOperationContract) => { x.operations.reverse(); },
    (x: PaidFullOperationContract) => { x.operations[0]!.regionKey = 'r1c1g2'; },
    (x: PaidFullOperationContract) => { x.profile.routes.classification!.tariff.inputUsdPerMillion = .001; },
    (x: PaidFullOperationContract) => { x.pricing.amountCents = 1; }]) {
    const modified = structuredClone(c); change(modified); assert.throws(() => validatePaidFullContract(modified, env, now));
  }
  const oldEnv = pricingEnv(), legacy = buildPaidFullContract({ manifest: testManifest(), membership: 'standard', env: oldEnv, now });
  const currentEnv = { ...oldEnv, PAID_FULL_PROFILE_JSON: env.PAID_FULL_PROFILE_JSON! };
  assert.equal(hashPaidFullContract(validatePaidFullContract(legacy, currentEnv, now)), hashPaidFullContract(legacy));
  assert.equal(legacy.version, 'paid-full-v1');
});

test('scheduling packs indivisible per-operation holds in saved order and uses current DB capacity', async () => {
  const c = build();
  const db = (cap = 25, available = 25, base = 2.5, windowCapacity = cap): any => ({ rpc: async () => ({ data: {
    enabled: true, spend_cap_usd: cap, call_reservation_usd: base, rolling_window_seconds: 86400, available_usd: available,
    window_capacity_usd: windowCapacity }, error: null }) });
  const expiry = Date.parse(c.pricing.expiresAt);
  // The saved order needs four windows: 20.5 | 24.52 | 20 | 6.
  await requirePaidFullBatchScheduling(db(), [c], expiry - 3 * 86400_000 - 1);
  await assert.rejects(requirePaidFullBatchScheduling(db(), [c], expiry - 3 * 86400_000), /price validity/);
  await assert.rejects(requirePaidFullBatchScheduling(db(25, 0), [c], expiry - 3 * 86400_000 - 1), /price validity/);
  await assert.rejects(requirePaidFullBatchScheduling(db(20), [c], now), /individual/);
  await assert.rejects(requirePaidFullBatchScheduling(db(25, 15, 2.5, 15), [c], now), /individual/);
  await assert.rejects(requirePaidFullBatchScheduling(db(25, 25, 3), [c], now), /schedule/);
  const corrupt = structuredClone(c); corrupt.operations.pop();
  await assert.rejects(requirePaidFullBatchScheduling(db(), [corrupt], now), /schedule/);
});

test('v2 checkout binds the saved hash and DB-derived base, and a reduced cap blocks before Stripe', async () => {
  const env = { ...multiproviderEnv(), TAKEOFF_V2_CALL_RESERVATION_USD: '0.01', STRIPE_SECRET_KEY: 'rk_live_synthetic',
    STRIPE_WEBHOOK_SECRET: 'whsec_synthetic', STRIPE_EXPECTED_ACCOUNT_ID: 'acct_synthetic', APP_URL: 'https://roughbid.test' };
  const contract = build(env);
  const quote = { id: 'quote-synthetic', user_id: 'user-synthetic', workspace_id: 'workspace-synthetic', project_id: 'project-synthetic',
    file_id: 'file-synthetic', mode: 'full_v2', status: 'quoted', expires_at: new Date(Date.now() + 3600_000).toISOString(), livemode: true,
    currency: 'usd', amount_cents: contract.pricing.amountCents, cost_cents: contract.pricing.costCents, page_count: 1,
    file_sha256: contract.manifest.fileSha256, full_contract: contract, full_contract_hash: hashPaidFullContract(contract) };
  const calls: Array<{ name: string; args: any }> = [], requests: string[] = [];
  let cap = 25;
  const db: any = { from(table: string) { const query: any = { select: () => query, update: () => query, eq: () => query, maybeSingle: () => query,
    then: (resolve: any, reject: any) => Promise.resolve({ data: table === 'workspaces' ? { ai_processing_consented_at: '2026-10-01' } : quote, error: null }).then(resolve, reject) }; return query; },
    async rpc(name: string, args: any) { calls.push({ name, args }); return { error: null, data: name === 'paid_full_capacity_policy'
      ? { enabled: true, spend_cap_usd: cap, call_reservation_usd: 2.5, rolling_window_seconds: 86400, available_usd: 25 } : true }; } };
  const input = { db, env, userId: quote.user_id, workspaceId: quote.workspace_id, projectId: quote.project_id, quoteId: quote.id,
    consent: { confirmed: true, contract_hash: quote.full_contract_hash }, ready: async () => {},
    fetcher: (async (url: any, init?: RequestInit) => { requests.push(String(url));
      if (String(url) === 'https://api.stripe.com/v1/account') return Response.json({ id: 'acct_synthetic', charges_enabled: true });
      assert.equal(String(url), 'https://api.stripe.com/v1/checkout/sessions');
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('metadata[roughbid_contract_hash]'), quote.full_contract_hash);
      assert.equal(body.get('line_items[0][price_data][unit_amount]'), String(quote.amount_cents));
      return Response.json({ id: 'cs_synthetic', url: 'https://checkout.stripe.com/synthetic' }); }) as typeof fetch };
  assert.deepEqual(await openPaidFullCheckout(input), { url: 'https://checkout.stripe.com/synthetic' });
  assert.equal(calls.find(c => c.name === 'paid_full_capacity_ready')?.args.p_call_reservation_usd, 2.5);
  assert.equal(calls.find(c => c.name === 'accept_paid_full_quote')?.args.p_contract_hash, quote.full_contract_hash);
  cap = 20; calls.length = 0; requests.length = 0;
  await assert.rejects(openPaidFullCheckout(input), /individual processing/);
  assert.deepEqual(requests, []); assert.equal(calls.some(c => c.name === 'accept_paid_full_quote'), false);
  cap = 25; calls.length = 0;
  await assert.rejects(openPaidFullCheckout({ ...input, consent: { confirmed: true, contract_hash: 'stale' } }), /explicitly accept/);
  assert.deepEqual(requests, []); assert.deepEqual(calls, []);
});
