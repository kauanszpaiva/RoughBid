import { createHash } from 'node:crypto';
import { ProjectApiError } from '../projects/service.ts';
import { AI_EVIDENCE_PASSES, STAGE_MODEL_REGISTRY, requireStageDeepPassConfig, type ConfiguredEvidenceStage, type StageProviderName } from '../takeoff-v2/stage-config.ts';
import type { DeepPassType, PlanSetManifest } from '../takeoff-v2/types.ts';
import { PROJECT_MARGIN_BPS, projectChargeCents, type ProjectMembership } from '../../../../packages/domain/src/project-charge.ts';
import { maximumTokenCostUsd } from './provider-cost-bound.ts';

// Standard text/image/PDF input and output INCLUDING thinking. No grounding,
// cache storage or other paid tools are enabled in this reviewed profile.
// https://ai.google.dev/gemini-api/docs/pricing#gemini-3.8-flash
// (1,048,576 * .75 + 65,536 * 3.75) / 1e6 = 1.032192 USD.
export const PAID_FULL_TARIFF = Object.freeze({ model: 'gemini-3.8-flash', inputPerMillionUsd: .75,
  outputPerMillionUsd: 3.75, maximumCallCostUsd: 1.04, expiresAt: '2027-01-01T00:00:00.000Z' });
export const PAID_FULL_EXECUTION_POLICY = 'one-durable-run-budget-wait-no-uncertain-replay' as const;
export interface PaidFullLegacyContract {
  version: 'paid-full-v1';
  manifest: PlanSetManifest;
  policyId: string;
  providers: Array<{ provider: StageProviderName; models: string[]; approvedUsd: number; maximumCalls: number }>;
  maximumCalls: number;
  regionGrid: 2;
  stages: string[];
  executionPolicy: typeof PAID_FULL_EXECUTION_POLICY;
  pricing: { version: string; currency: 'usd'; costCents: number; amountCents: number; membership: ProjectMembership;
    marginBps: number; paymentFixedCents: number; paymentFeeBps: number; providerCostUpperBoundUsd: number;
    operatingReserveUsd: number; expiresAt: string };
}
export interface FullOperationPricing {
  key: string; physicalPageNumber: number; passType: DeepPassType; regionKey: string | null;
  provider: StageProviderName; model: string; maximumCallCostUsd: number; reservationUsd: number;
}
export interface FullRouteTariff {
  /** Worst applicable standard, uncached tier; includes all billed reasoning output. */
  inputUsdPerMillion: number; outputUsdPerMillion: number;
  /** Reviewed maximum accepted input, not an estimate of this document's tokens. */
  inputTokenLimit: number; outputTokenLimit: number; additionalRequestUsd: number;
  combinedContextTokenLimit?: number;
  source: string; verifiedAt: string; expiresAt: string;
  standardUncached: true; reasoningIncluded: true; maximumAcceptedInput: true;
}
export interface FullPricedRoute extends Omit<ConfiguredEvidenceStage, 'apiKey'> {
  inputKind: 'pdf' | 'images'; timeoutMs: number; priceVersion: string;
  maximumCallCostUsd: number; tariff: FullRouteTariff;
}
export interface FullProcessingProfile {
  version: 'full-processing-v2'; profileHash: string; routes: Partial<Record<DeepPassType, FullPricedRoute>>;
  regionalReview: { enabled: true; grid: 2 }; expiresAt: string;
  transport: 'direct' | 'bridge'; templateVersion: 'full-evidence-v1';
  maximumPageBytes: 10485760; maximumContextCharacters: 24000;
  renderer?: { version: 'pdfjs-canvas-crop-v1'; maximumEdgePixels: 1300; jpegQuality: 92 };
}
export interface PaidFullOperationContract extends Omit<PaidFullLegacyContract, 'version' | 'pricing'> {
  version: 'paid-full-v2'; operations: FullOperationPricing[]; profile: FullProcessingProfile;
  pricing: PaidFullLegacyContract['pricing'] & { callReservationUsd: number;
    overheadBaseCents: number; overheadPageCents: number; overheadBasePolicy: 'purchase' };
}
export type PaidFullContract = PaidFullLegacyContract | PaidFullOperationContract;
export interface FullCompanyPolicy { callReservationUsd: number; spendCapUsd: number }
type Env = Record<string, string | undefined>;
function unavailable(message: string): never { throw new ProjectApiError(503, `Full reading purchase is unavailable: ${message}`); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function hashPaidFullContract(contract: PaidFullContract): string {
  return createHash('sha256').update(canonical(contract)).digest('hex');
}
function integer(env: Env, name: string, minimum: number): number {
  const raw = env[name];
  const number = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(number) || number < minimum) unavailable('the processing price is not fully configured. Please contact support.');
  return number;
}
type FullContractInput = { manifest: PlanSetManifest; membership: ProjectMembership; env: Env; now?: number; companyPolicy?: FullCompanyPolicy };
function buildLegacyPaidFullContract(input: FullContractInput): PaidFullLegacyContract {
  const { manifest, membership, env } = input;
  if (env.PAID_FULL_ENABLED !== 'true' || env.STRIPE_MODE !== 'live') unavailable('the paid Full profile must be explicitly enabled for live payment.');
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now) || now >= Date.parse(PAID_FULL_TARIFF.expiresAt)) unavailable('the reviewed model tariff has expired.');
  if (!manifest || !Number.isSafeInteger(manifest.physicalPageCount) || manifest.physicalPageCount < 1 || manifest.physicalPageCount > 200
    || !/^[a-f0-9]{64}$/.test(manifest.fileSha256) || !Array.isArray(manifest.sheets) || manifest.sheets.length !== manifest.physicalPageCount
    || Object.keys(manifest).some(key => !['fileSha256', 'physicalPageCount', 'sheets'].includes(key))
    || manifest.sheets.some((sheet, index) => sheet.physicalPageNumber !== index + 1 || !/^[a-f0-9]{64}$/.test(sheet.pageSha256)
      || ![0,90,180,270].includes(sheet.rotationDegrees) || !Number.isFinite(sheet.widthPoints) || sheet.widthPoints <= 0 || !Number.isFinite(sheet.heightPoints) || sheet.heightPoints <= 0)) {
    throw new ProjectApiError(422, 'Full purchase requires a complete PDF with 1 to 200 physical pages and valid page orientation.');
  }
  if (!Object.hasOwn(PROJECT_MARGIN_BPS, membership)) unavailable('a verified membership is required.');
  const config = requireStageDeepPassConfig(env);
  if (!config.regionalReview.enabled || config.regionalReview.grid !== 2 || env.GEOMETRY_PROVIDER_ENABLED === 'true' || env.TAKEOFF_V2_KAMAI_ENABLED === 'true') {
    unavailable('the reviewed seven-stage, 2 by 2 region profile is required.');
  }
  const stages = AI_EVIDENCE_PASSES.map(name => {
    const stage = config.stages[name];
    if (!stage || stage.provider !== 'gemini' || stage.model !== PAID_FULL_TARIFF.model || stage.maxOutputTokens > 65_536
      || stage.attestation.maximumCallCostUsd < PAID_FULL_TARIFF.maximumCallCostUsd) unavailable('all seven stages require the reviewed Gemini 3.8 Flash profile.');
    return { name, provider: stage.provider, model: stage.model, reasoningEffort: stage.reasoningEffort,
      maxOutputTokens: stage.maxOutputTokens, attestation: stage.attestation };
  });
  const version = env.PAID_FULL_PRICING_VERSION;
  if (!version || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{1,79}$/.test(version)) unavailable('an explicit pricing version is required.');
  const base = integer(env, 'PAID_FULL_OVERHEAD_BASE_CENTS', 0);
  const perPage = integer(env, 'PAID_FULL_OVERHEAD_PAGE_CENTS', 0);
  const fixed = integer(env, 'PROJECT_PAYMENT_FIXED_CENTS', 0);
  const feeBps = integer(env, 'PROJECT_PAYMENT_FEE_BPS', 0);
  const callLimit = integer(env, 'PAID_FULL_MAXIMUM_CALLS', 1);
  const reserveLimit = Number(env.PAID_FULL_MAXIMUM_RESERVE_USD);
  const companyReservation = Number(env.TAKEOFF_V2_CALL_RESERVATION_USD);
  if (!Number.isFinite(reserveLimit) || reserveLimit <= 0 || reserveLimit > 100_000
    || !Number.isFinite(companyReservation) || companyReservation <= 0 || companyReservation > 100_000) unavailable('review paid execution and company reservation limits.');
  // Four whole-page stages plus three stages covering all four regions. One
  // attempt per call; uncertain calls are never automatically replayed. This
  // whole-run allowance remains intact while admission spans daily windows.
  const maximumCalls = manifest.physicalPageCount * (4 + 3 * 2 * 2);
  const reservationPerCall = Math.max(companyReservation, ...stages.map(stage => stage.attestation.maximumCallCostUsd));
  const operatingReserveUsd = Math.ceil(maximumCalls * reservationPerCall * 1_000_000) / 1_000_000;
  if (maximumCalls > callLimit || operatingReserveUsd > reserveLimit) unavailable('the complete document exceeds the reviewed execution capacity.');
  const providerCostCents = maximumCalls * 104;
  const costCents = providerCostCents + base + manifest.physicalPageCount * perPage;
  let amountCents: number;
  try { amountCents = projectChargeCents(costCents, fixed, feeBps, membership); }
  catch { unavailable('the reviewed price and fee policy is invalid.'); }
  const policyId = createHash('sha256').update(canonical({ stages, regionalReview: config.regionalReview,
    requestTimeoutMs: config.requestTimeoutMs, tariff: PAID_FULL_TARIFF, version, base, perPage, fixed, feeBps,
    callLimit, reserveLimit, companyReservation, executionPolicy: PAID_FULL_EXECUTION_POLICY })).digest('hex');
  return { version: 'paid-full-v1', manifest, policyId, maximumCalls, regionGrid: 2, stages: stages.map(stage => stage.name),
    providers: [{ provider: 'gemini', models: [PAID_FULL_TARIFF.model], approvedUsd: operatingReserveUsd, maximumCalls }],
    executionPolicy: PAID_FULL_EXECUTION_POLICY, pricing: { version, currency: 'usd', costCents, amountCents, membership,
      marginBps: PROJECT_MARGIN_BPS[membership], paymentFixedCents: fixed, paymentFeeBps: feeBps,
      providerCostUpperBoundUsd: providerCostCents / 100, operatingReserveUsd, expiresAt: PAID_FULL_TARIFF.expiresAt } };
}
const moneyMicros = (n: number) => Math.round(n * 1e6);
const validMoney = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0
  && Number.isSafeInteger(moneyMicros(n)) && Math.abs(n * 1e6 - moneyMicros(n)) < .000001;
const record = (n: unknown): n is Record<string, any> => Boolean(n) && typeof n === 'object' && !Array.isArray(n);
const PRIMARY_TARIFF_HOSTS: Record<StageProviderName, readonly string[]> = {
  openai: ['openai.com', 'platform.openai.com', 'developers.openai.com'],
  claude: ['anthropic.com', 'docs.anthropic.com', 'platform.claude.com'],
  gemini: ['ai.google.dev', 'cloud.google.com'],
  kimi: ['platform.moonshot.ai', 'platform.moonshot.cn', 'platform.kimi.ai'],
  deepseek: ['api-docs.deepseek.com'],
};
function primaryTariffSource(value: unknown, provider: StageProviderName): string {
  let url: URL;
  try { url = new URL(typeof value === 'string' ? value : ''); } catch { return unavailable('a primary tariff reference is required.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !PRIMARY_TARIFF_HOSTS[provider].includes(url.hostname)) {
    unavailable('a primary tariff reference is required.');
  }
  return url.href;
}

/** Explicit operator-reviewed snapshots. Credentials never establish prices. */
export function requireFullProcessingProfile(env: Env, now = Date.now()): FullProcessingProfile {
  if (env.TAKEOFF_V2_TRANSPORT !== 'bridge' || env.PROVIDER_BRIDGE_ENABLED !== 'true') {
    unavailable('the durable operation transport is required.');
  }
  let raw: unknown;
  try {
    if (!env.PAID_FULL_PROFILE_JSON || env.PAID_FULL_PROFILE_JSON.length > 65_536) unavailable('an explicit bounded processing profile is required.');
    raw = JSON.parse(env.PAID_FULL_PROFILE_JSON);
  } catch { return unavailable('an explicit bounded processing profile is required.'); }
  if (!record(raw) || raw.version !== 'full-processing-v2' || !record(raw.routes)
    || Object.keys(raw.routes).length !== AI_EVIDENCE_PASSES.length || !Number.isFinite(now)) unavailable('the reviewed seven-stage processing profile is required.');
  const config = requireStageDeepPassConfig(env);
  if (!config.regionalReview.enabled || config.regionalReview.grid !== 2 || env.GEOMETRY_PROVIDER_ENABLED === 'true' || env.TAKEOFF_V2_KAMAI_ENABLED === 'true') {
    unavailable('the reviewed seven-stage, 2 by 2 region profile is required.');
  }
  const routes: FullProcessingProfile['routes'] = {};
  for (const pass of AI_EVIDENCE_PASSES) {
    const stage = config.stages[pass], r = raw.routes[pass];
    if (!stage || !record(r) || r.provider !== stage.provider || r.model !== stage.model || r.reasoningEffort !== stage.reasoningEffort
      || r.maxOutputTokens !== stage.maxOutputTokens || r.timeoutMs !== config.requestTimeoutMs || r.priceVersion !== stage.attestation.priceVersion
      || r.maximumCallCostUsd !== stage.attestation.maximumCallCostUsd || !validMoney(r.maximumCallCostUsd)) {
      unavailable('the tariff must match each configured model, settings and reviewed exposure.');
    }
    const inputKind = STAGE_MODEL_REGISTRY[stage.model].inputKind;
    if (inputKind === 'text' || r.inputKind !== inputKind) unavailable('every purchased stage requires a supported visual input.');
    if (inputKind === 'images' && env.TAKEOFF_V2_TRANSPORT !== 'bridge') unavailable('the verified rendered-image transport is required.');
    const requestPolicy = (stage as ConfiguredEvidenceStage & { requestPolicy?: string }).requestPolicy;
    if (stage.provider === 'openai' && (requestPolicy !== 'explicit-cache-default-v1' || r.requestPolicy !== requestPolicy)) {
      unavailable('the reviewed explicit-cache and default-tier request policy is required.');
    }
    const t = r.tariff;
    if (!record(t) || t.standardUncached !== true || t.reasoningIncluded !== true || t.maximumAcceptedInput !== true
      || !Number.isSafeInteger(t.outputTokenLimit) || t.outputTokenLimit < stage.maxOutputTokens
      || t.combinedContextTokenLimit !== undefined && (!Number.isSafeInteger(t.combinedContextTokenLimit) || t.combinedContextTokenLimit < stage.maxOutputTokens)
      || typeof t.verifiedAt !== 'string' || !Number.isFinite(Date.parse(t.verifiedAt)) || Date.parse(t.verifiedAt) > now
      || typeof t.expiresAt !== 'string' || !Number.isFinite(Date.parse(t.expiresAt)) || Date.parse(t.expiresAt) <= now
      || Date.parse(t.verifiedAt) >= Date.parse(t.expiresAt)) unavailable('a current worst-case input/output tariff snapshot is required.');
    const tariff: FullRouteTariff = { inputUsdPerMillion: t.inputUsdPerMillion, outputUsdPerMillion: t.outputUsdPerMillion,
      inputTokenLimit: t.inputTokenLimit, outputTokenLimit: t.outputTokenLimit, additionalRequestUsd: t.additionalRequestUsd,
      ...(t.combinedContextTokenLimit === undefined ? {} : { combinedContextTokenLimit: t.combinedContextTokenLimit }),
      source: primaryTariffSource(t.source, stage.provider), verifiedAt: t.verifiedAt, expiresAt: t.expiresAt,
      standardUncached: true, reasoningIncluded: true, maximumAcceptedInput: true };
    let bound: number;
    try { bound = maximumTokenCostUsd(tariff); } catch { return unavailable('the reviewed token exposure is invalid.'); }
    if (r.maximumCallCostUsd < bound) unavailable('the reviewed maximum call cost does not cover the complete token exposure.');
    const { apiKey: _credential, ...publicStage } = stage;
    routes[pass] = { ...publicStage, inputKind, timeoutMs: config.requestTimeoutMs, priceVersion: r.priceVersion,
      maximumCallCostUsd: r.maximumCallCostUsd, tariff };
  }
  const base: Omit<FullProcessingProfile, 'profileHash'> = { version: 'full-processing-v2', routes,
    regionalReview: { enabled: true, grid: 2 }, expiresAt: new Date(Math.min(...Object.values(routes).map(r => Date.parse(r.tariff.expiresAt)))).toISOString(),
    transport: env.TAKEOFF_V2_TRANSPORT === 'bridge' ? 'bridge' : 'direct', templateVersion: 'full-evidence-v1',
    maximumPageBytes: 10485760, maximumContextCharacters: 24000,
    ...(Object.values(routes).some(r => r.inputKind === 'images') ? { renderer: { version: 'pdfjs-canvas-crop-v1' as const, maximumEdgePixels: 1300 as const, jpegQuality: 92 as const } } : {}) };
  return { ...base, profileHash: createHash('sha256').update(canonical(base)).digest('hex') };
}

/** Matches runDeepTakeoff: all-sheet inventory first, then each sheet's passes. */
export function planFullPricedOperations(manifest: PlanSetManifest, profile: FullProcessingProfile, policy: FullCompanyPolicy): FullOperationPricing[] {
  if (!validMoney(policy.callReservationUsd) || !validMoney(policy.spendCapUsd) || policy.callReservationUsd > policy.spendCapUsd) {
    unavailable('the company processing policy is unavailable.');
  }
  const inventory: DeepPassType[] = ['classification', 'legends_schedules'];
  const tasks = [...inventory.flatMap(passType => manifest.sheets.map(sheet => ({ sheet, passType }))),
    ...manifest.sheets.flatMap(sheet => AI_EVIDENCE_PASSES.filter(passType => !inventory.includes(passType)).map(passType => ({ sheet, passType })))];
  return tasks.flatMap(({ sheet, passType }) => {
    const route = profile.routes[passType];
    if (!route) return unavailable('a configured evidence stage is missing.');
    const reservationUsd = Math.max(policy.callReservationUsd, route.maximumCallCostUsd);
    if (reservationUsd > policy.spendCapUsd) unavailable('an individual processing operation exceeds the company capacity.');
    const regions: (string | null)[] = ['discipline', 'conflict_detection', 'completeness'].includes(passType)
      ? ['r1c1g2', 'r1c2g2', 'r2c1g2', 'r2c2g2'] : [null];
    return regions.map(regionKey => ({ key: `page:${sheet.physicalPageNumber}:${passType}:${regionKey ?? 'whole'}`,
      physicalPageNumber: sheet.physicalPageNumber, passType, regionKey, provider: route.provider, model: route.model,
      maximumCallCostUsd: route.maximumCallCostUsd, reservationUsd }));
  });
}

function buildOperationPaidFullContract(input: FullContractInput): PaidFullOperationContract {
  const { manifest, membership, env } = input;
  if (env.PAID_FULL_ENABLED !== 'true' || env.STRIPE_MODE !== 'live') unavailable('the paid Full profile must be explicitly enabled for live payment.');
  if (!manifest || !Number.isSafeInteger(manifest.physicalPageCount) || manifest.physicalPageCount < 1 || manifest.physicalPageCount > 200
    || !/^[a-f0-9]{64}$/.test(manifest.fileSha256) || !Array.isArray(manifest.sheets) || manifest.sheets.length !== manifest.physicalPageCount
    || Object.keys(manifest).some(key => !['fileSha256', 'physicalPageCount', 'sheets'].includes(key))
    || manifest.sheets.some((sheet, index) => sheet.physicalPageNumber !== index + 1 || !/^[a-f0-9]{64}$/.test(sheet.pageSha256)
      || ![0, 90, 180, 270].includes(sheet.rotationDegrees) || !Number.isFinite(sheet.widthPoints) || sheet.widthPoints <= 0 || !Number.isFinite(sheet.heightPoints) || sheet.heightPoints <= 0)) {
    throw new ProjectApiError(422, 'Full purchase requires a complete PDF with 1 to 200 physical pages and valid page orientation.');
  }
  if (!Object.hasOwn(PROJECT_MARGIN_BPS, membership) || !input.companyPolicy) unavailable('a verified membership and company policy are required.');
  const profile = requireFullProcessingProfile(env, input.now ?? Date.now());
  const operations = planFullPricedOperations(manifest, profile, input.companyPolicy);
  const maximumCalls = operations.length;
  const version = env.PAID_FULL_PRICING_VERSION;
  if (!version || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{1,79}$/.test(version)) unavailable('an explicit pricing version is required.');
  const base = integer(env, 'PAID_FULL_OVERHEAD_BASE_CENTS', 0), perPage = integer(env, 'PAID_FULL_OVERHEAD_PAGE_CENTS', 0);
  if (env.PAID_FULL_OVERHEAD_BASE_POLICY !== 'purchase') unavailable('an explicit per-purchase processing overhead policy is required.');
  const fixed = integer(env, 'PROJECT_PAYMENT_FIXED_CENTS', 0), feeBps = integer(env, 'PROJECT_PAYMENT_FEE_BPS', 0);
  const callLimit = integer(env, 'PAID_FULL_MAXIMUM_CALLS', 1), reserveLimit = Number(env.PAID_FULL_MAXIMUM_RESERVE_USD);
  const operatingReserveUsd = operations.reduce((sum, op) => sum + moneyMicros(op.reservationUsd), 0) / 1e6;
  const providerCostUpperBoundUsd = operations.reduce((sum, op) => sum + moneyMicros(op.maximumCallCostUsd), 0) / 1e6;
  if (!validMoney(reserveLimit) || reserveLimit > 100_000 || maximumCalls > callLimit || operatingReserveUsd > reserveLimit) {
    unavailable('the complete document exceeds the reviewed execution capacity.');
  }
  const costCents = Math.ceil(moneyMicros(providerCostUpperBoundUsd) / 10_000) + base + manifest.physicalPageCount * perPage;
  let amountCents: number;
  try { amountCents = projectChargeCents(costCents, fixed, feeBps, membership); } catch { return unavailable('the reviewed price and fee policy is invalid.'); }
  const providers = [...new Set(operations.map(op => op.provider))].sort().map(provider => {
    const selected = operations.filter(op => op.provider === provider);
    return { provider, models: [...new Set(selected.map(op => op.model))].sort(), maximumCalls: selected.length,
      approvedUsd: selected.reduce((sum, op) => sum + moneyMicros(op.reservationUsd), 0) / 1e6 };
  });
  const policyId = createHash('sha256').update(canonical({ profile, version, base, perPage, overheadBasePolicy: 'purchase', fixed, feeBps, callLimit, reserveLimit,
    callReservationUsd: input.companyPolicy.callReservationUsd, executionPolicy: PAID_FULL_EXECUTION_POLICY })).digest('hex');
  return { version: 'paid-full-v2', manifest, policyId, providers, maximumCalls, regionGrid: 2, stages: [...AI_EVIDENCE_PASSES],
    operations, profile, executionPolicy: PAID_FULL_EXECUTION_POLICY,
    pricing: { version, currency: 'usd', costCents, amountCents, membership, marginBps: PROJECT_MARGIN_BPS[membership],
      paymentFixedCents: fixed, paymentFeeBps: feeBps, providerCostUpperBoundUsd, operatingReserveUsd,
      callReservationUsd: input.companyPolicy.callReservationUsd, overheadBaseCents: base, overheadPageCents: perPage,
      overheadBasePolicy: 'purchase', expiresAt: profile.expiresAt } };
}

export function buildPaidFullContract(input: FullContractInput): PaidFullContract {
  // An explicitly present but invalid v2 profile cannot fall back to legacy.
  return input.env.PAID_FULL_PROFILE_JSON === undefined ? buildLegacyPaidFullContract(input) : buildOperationPaidFullContract(input);
}
/** Rebuild using the worker's current reviewed profile; JSONB key order is irrelevant. */
export function validatePaidFullContract(contract: PaidFullContract, env: Env, now?: number): PaidFullContract {
  if (!contract || !['paid-full-v1', 'paid-full-v2'].includes(contract.version) || !contract.pricing) unavailable('the saved execution contract is invalid.');
  if (contract.version === 'paid-full-v2' && (!Array.isArray(contract.operations) || !contract.operations.length
    || contract.operations.length !== contract.maximumCalls || contract.operations.some(op => !record(op) || !validMoney(op.reservationUsd)))) {
    unavailable('the saved operation contract is invalid.');
  }
  const input = { manifest: contract.manifest, membership: contract.pricing.membership, env, ...(now === undefined ? {} : { now }) };
  // Dispatch still checks the current database cap. Rebuilding an immutable
  // profile must not silently replace its base hold with a later policy.
  const current = contract.version === 'paid-full-v1' ? buildLegacyPaidFullContract(input)
    : buildOperationPaidFullContract({ ...input, companyPolicy: { callReservationUsd: contract.pricing.callReservationUsd,
      spendCapUsd: Math.max(contract.pricing.callReservationUsd, ...contract.operations.map(op => op.reservationUsd)) } });
  if (hashPaidFullContract(current) !== hashPaidFullContract(contract)) unavailable('the saved execution profile changed; refresh the quote.');
  return current;
}
