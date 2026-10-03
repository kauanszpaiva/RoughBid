import { createHash } from 'node:crypto';
import { isConfiguredValue } from '../ai-plan/readiness.ts';
import { ProjectApiError } from '../projects/service.ts';
import { STAGE_MODEL_REGISTRY, STAGE_REASONING_CAPABILITIES, type StageReasoningEffort } from '../takeoff-v2/stage-config.ts';
import type { MaximumPhotoModel, PhotoProviderName } from '../photo-evidence/profile.ts';
import { requireCompletePhotoProfile, type CompletePhotoProfile, type CompletePhotoRoute } from './complete-profile.ts';

export const PHOTO_TAKEOFF_VERSION = 'photo-takeoff-v1';
export interface PhotoTakeoffProfile {
  provider: PhotoProviderName;
  model: MaximumPhotoModel;
  reasoningEffort: StageReasoningEffort;
  maxOutputTokens: number;
  timeoutMs: number;
  maximumCallCostUsd: number;
  priceVersion: string;
  approvedRunBudgetUsd: number;
  runBudgetApprovalRef: string;
  /** Stable public configuration identity, containing no credential. */
  profileHash: string;
  complete?: CompletePhotoProfile;
  requestPolicy?:{serviceTier:'default';promptCacheMode:'explicit'};
  tariff?:CompletePhotoRoute['tariff'];
}
export interface PhotoTakeoffConfig extends PhotoTakeoffProfile { apiKey: string; stageConfigs?: Record<'observation'|'reconciliation'|'risk_review',PhotoTakeoffProfile&{apiKey:string}> }
function fail(message: string): never { throw new ProjectApiError(503, `Photo takeoff: ${message}`); }

/** No default model, credential filesystem reads, fallback or network calls. */
export function requirePhotoTakeoffProfile(env: Record<string, string | undefined>): PhotoTakeoffProfile {
  if (env.PHOTO_TAKEOFF_ENABLED !== 'true' || env.PHOTO_TAKEOFF_SCHEMA_VERSION !== PHOTO_TAKEOFF_VERSION
    || env.PRIVATE_PHOTO_DATA_APPROVED !== 'true') fail('reviewed enablement, schema and private-photo processing authorization are required.');
  if(env.PHOTO_COMPLETE_ENABLED==='true'){
    const complete=requireCompletePhotoProfile(env),route=complete.routes.observation;
    const approved=Number(env.PHOTO_TAKEOFF_APPROVED_RUN_BUDGET_USD),ref=env.PHOTO_TAKEOFF_RUN_BUDGET_APPROVAL_REF?.trim();
    // A paid contract supplies its own authorization. Included owner access
    // still requires the separately configured, explicit existing allowance.
    const included=Number.isFinite(approved)&&approved>0&&approved<=100000&&!!ref&&/^[A-Za-z0-9][A-Za-z0-9_.:/-]{1,119}$/.test(ref);
    return {provider:route.provider,model:route.model,reasoningEffort:route.reasoningEffort,maxOutputTokens:route.maxOutputTokens,
      timeoutMs:route.timeoutMs,maximumCallCostUsd:route.maximumCallCostUsd,priceVersion:route.priceVersion,
      approvedRunBudgetUsd:included?approved:0,runBudgetApprovalRef:included?ref!:'',profileHash:complete.profileHash,complete};
  }
  const provider = env.PHOTO_TAKEOFF_PROVIDER?.trim();
  if (provider !== 'openai' && provider !== 'claude' && provider !== 'gemini') fail('an explicit OpenAI, Claude or Gemini provider is required.');
  const model = env.PHOTO_TAKEOFF_MODEL?.trim();
  if (!model || !['gpt-6-astra', 'claude-opus-5-5', 'gemini-3.1-pro-preview'].includes(model)
    || STAGE_MODEL_REGISTRY[model as MaximumPhotoModel].provider !== provider) fail('the exact configured maximum-quality model is unsupported.');
  let attestations: Record<string, any>;
  try {
    if (!env.PHOTO_TAKEOFF_MODEL_ATTESTATIONS_JSON || env.PHOTO_TAKEOFF_MODEL_ATTESTATIONS_JSON.length > 16_384) fail('model verification is required.');
    attestations = JSON.parse(env.PHOTO_TAKEOFF_MODEL_ATTESTATIONS_JSON);
  } catch { fail('model attestations must be valid JSON.'); }
  const attestation = attestations![model];
  if (!attestation || attestation.accountVerified !== true || attestation.imageCompatibilityVerified !== true
    || typeof attestation.priceVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{1,119}$/.test(attestation.priceVersion)
    || typeof attestation.maximumCallCostUsd !== 'number' || !Number.isFinite(attestation.maximumCallCostUsd)
    || attestation.maximumCallCostUsd <= 0 || attestation.maximumCallCostUsd > 100_000) fail('exact-model account, image compatibility and reviewed maximum call cost must be attested.');
  const capabilities = STAGE_REASONING_CAPABILITIES[model as MaximumPhotoModel];
  const reasoningEffort = env.PHOTO_TAKEOFF_REASONING_EFFORT ?? capabilities.maximum;
  if (!capabilities.levels.includes(reasoningEffort as StageReasoningEffort)) fail('the selected reasoning effort is unsupported.');
  const maxOutputTokens = Number(env.PHOTO_TAKEOFF_MAX_OUTPUT_TOKENS ?? capabilities.outputDefault);
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 4_096 || maxOutputTokens > capabilities.outputCeiling) fail('output token budget is invalid.');
  const timeoutMs = Number(env.PHOTO_TAKEOFF_PROVIDER_TIMEOUT_MS ?? 120_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) fail('technical attempt timeout is invalid.');
  const approvedRunBudgetUsd=Number(env.PHOTO_TAKEOFF_APPROVED_RUN_BUDGET_USD);
  const runBudgetApprovalRef=env.PHOTO_TAKEOFF_RUN_BUDGET_APPROVAL_REF?.trim();
  if (!Number.isFinite(approvedRunBudgetUsd)||approvedRunBudgetUsd<=0||approvedRunBudgetUsd>100_000
    ||!runBudgetApprovalRef||!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{1,119}$/.test(runBudgetApprovalRef)) fail('a separately approved per-run/provider budget and authorization reference are required. Account credit is not authorization.');
  const profileHash = createHash('sha256').update(JSON.stringify({ version: PHOTO_TAKEOFF_VERSION, provider, model,
    reasoningEffort, maxOutputTokens, priceVersion: attestation.priceVersion,
    maximumCallCostUsd: attestation.maximumCallCostUsd,approvedRunBudgetUsd,runBudgetApprovalRef })).digest('hex');
  return { provider, model: model as MaximumPhotoModel, reasoningEffort: reasoningEffort as StageReasoningEffort,
    maxOutputTokens, timeoutMs, priceVersion: attestation.priceVersion, maximumCallCostUsd: attestation.maximumCallCostUsd,
    approvedRunBudgetUsd,runBudgetApprovalRef,profileHash };
}
export function requirePhotoTakeoffConfig(env: Record<string, string | undefined>): PhotoTakeoffConfig {
  const profile = requirePhotoTakeoffProfile(env);
  const apiKey = (profile.provider === 'openai' ? env.OPENAI_API_KEY : profile.provider === 'claude' ? env.ANTHROPIC_API_KEY : env.GEMINI_API_KEY)?.trim();
  if (!isConfiguredValue(apiKey)) fail('the selected provider credential is unavailable on the worker.');
  const forStage=(stage:'observation'|'reconciliation'|'risk_review')=>{
    const route=profile.complete!.routes[stage];
    const key=(route.provider==='openai'?env.OPENAI_API_KEY:route.provider==='claude'?env.ANTHROPIC_API_KEY:env.GEMINI_API_KEY)?.trim();
    if(!isConfiguredValue(key))fail('a configured photo stage credential is unavailable on the worker.');
    const {complete,...base}=profile;
    return {...base,...route,apiKey:key!};
  };
  const stageConfigs=profile.complete?{observation:forStage('observation'),reconciliation:forStage('reconciliation'),risk_review:forStage('risk_review')}:undefined;
  return {...profile,apiKey:apiKey!,...(stageConfigs?{stageConfigs}:{})};
}
