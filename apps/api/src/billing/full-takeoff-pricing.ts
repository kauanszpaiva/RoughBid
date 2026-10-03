import { createHash } from 'node:crypto';
import { ProjectApiError } from '../projects/service.ts';
import { AI_EVIDENCE_PASSES, requireStageDeepPassConfig, type StageProviderName } from '../takeoff-v2/stage-config.ts';
import type { PlanSetManifest } from '../takeoff-v2/types.ts';
import { PROJECT_MARGIN_BPS, projectChargeCents, type ProjectMembership } from '../../../../packages/domain/src/project-charge.ts';

// Standard text/image/PDF input and output INCLUDING thinking. No grounding,
// cache storage or other paid tools are enabled in this reviewed profile.
// https://ai.google.dev/gemini-api/docs/pricing#gemini-3.8-flash
// (1,048,576 * .75 + 65,536 * 3.75) / 1e6 = 1.032192 USD.
export const PAID_FULL_TARIFF = Object.freeze({ model: 'gemini-3.8-flash', inputPerMillionUsd: .75,
  outputPerMillionUsd: 3.75, maximumCallCostUsd: 1.04, expiresAt: '2027-01-01T00:00:00.000Z' });
export const PAID_FULL_EXECUTION_POLICY = 'one-durable-run-budget-wait-no-uncertain-replay' as const;
export interface PaidFullContract {
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
export function buildPaidFullContract(input: { manifest: PlanSetManifest; membership: ProjectMembership; env: Env; now?: number }): PaidFullContract {
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
/** Rebuild using the worker's current reviewed profile; JSONB key order is irrelevant. */
export function validatePaidFullContract(contract: PaidFullContract, env: Env, now?: number): PaidFullContract {
  if (!contract || contract.version !== 'paid-full-v1' || !contract.pricing) unavailable('the saved execution contract is invalid.');
  const current = buildPaidFullContract({ manifest: contract.manifest, membership: contract.pricing.membership, env, ...(now === undefined ? {} : { now }) });
  if (hashPaidFullContract(current) !== hashPaidFullContract(contract)) unavailable('the saved execution profile changed; refresh the quote.');
  return current;
}
