import { isConfiguredValue } from '../ai-plan/readiness.ts';
import { ProjectApiError } from '../projects/service.ts';
import { RENDERED_VISION_MODELS, requireImageProviderBaseUrl } from '../ai-plan/vision-capabilities.ts';
import type { DeepPassType } from './types.ts';

export type StageProviderName = 'openai' | 'claude' | 'gemini' | 'kimi' | 'deepseek';
/** Public API IDs verified on 2026-10-02. Account access is a separate gate. */
export const STAGE_MODEL_REGISTRY = Object.freeze({
  'gpt-6-astra': { provider: 'openai', inputKind: 'pdf', documentation: 'https://developers.openai.com/api/docs/models/gpt-6-astra' },
  'claude-opus-5-5': { provider: 'claude', inputKind: 'pdf', documentation: 'https://platform.claude.com/docs/en/models/opus-5-5/overview' },
  'claude-fable-5-1': { provider: 'claude', inputKind: 'pdf', documentation: 'https://platform.claude.com/docs/en/models/fable-5-1/overview' },
  'gemini-3.1-pro-preview': { provider: 'gemini', inputKind: 'pdf', documentation: 'https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview' },
  'gemini-3.8-flash': { provider: 'gemini', inputKind: 'pdf', documentation: 'https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash' },
  'kimi-k3': { ...RENDERED_VISION_MODELS['kimi-k3'], inputKind: 'images' },
  'kimi-k2.6': { ...RENDERED_VISION_MODELS['kimi-k2.6'], inputKind: 'images' },
  'deepseek-flash': { ...RENDERED_VISION_MODELS['deepseek-flash'], inputKind: 'images' },
  'deepseek-v4-pro': { provider: 'deepseek', inputKind: 'text', documentation: 'https://api-docs.deepseek.com/quick_start/pricing/' },
} as const);
export type StageModelId = keyof typeof STAGE_MODEL_REGISTRY;
export type StageReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** The selected model remains unchanged when effort is configured. */
export const STAGE_REASONING_CAPABILITIES: Readonly<Record<StageModelId, { levels: readonly StageReasoningEffort[]; maximum: StageReasoningEffort; outputCeiling: number; outputDefault: number }>> = {
  'gpt-6-astra': { levels: ['low', 'medium', 'high', 'xhigh', 'max'], maximum: 'max', outputCeiling: 128_000, outputDefault: 64_000 },
  'claude-opus-5-5': { levels: ['low', 'medium', 'high', 'xhigh', 'max'], maximum: 'max', outputCeiling: 128_000, outputDefault: 64_000 },
  'claude-fable-5-1': { levels: ['low', 'medium', 'high', 'xhigh', 'max'], maximum: 'max', outputCeiling: 128_000, outputDefault: 64_000 },
  'gemini-3.1-pro-preview': { levels: ['low', 'high'], maximum: 'high', outputCeiling: 65_536, outputDefault: 64_000 },
  'gemini-3.8-flash': { levels: ['low', 'medium', 'high'], maximum: 'high', outputCeiling: 65_536, outputDefault: 64_000 },
  'kimi-k3': { levels: ['low', 'high', 'max'], maximum: 'max', outputCeiling: 1_048_576, outputDefault: 64_000 },
  'kimi-k2.6': { levels: ['low', 'high'], maximum: 'high', outputCeiling: 32_768, outputDefault: 16_000 },
  'deepseek-flash': { levels: ['low', 'high', 'max'], maximum: 'max', outputCeiling: 393_216, outputDefault: 64_000 },
  'deepseek-v4-pro': { levels: ['low', 'high', 'max'], maximum: 'max', outputCeiling: 393_216, outputDefault: 64_000 },
};
export const AI_EVIDENCE_PASSES: readonly DeepPassType[] = [
  'classification', 'legends_schedules', 'discipline', 'reconciliation',
  'conflict_detection', 'completeness', 'risk_review',
];
export const LOCAL_PASSES: readonly DeepPassType[] = ['geometry', 'arithmetic_qa', 'pricing_assemblies'];

export interface StageModelAttestation {
  accountVerified: true;
  compatibilityVerified: true;
  /** Operator-reviewed tariff/version reference. This is not an actual-cost claim. */
  priceVersion: string;
  /** Reviewed upper exposure for this bounded request; actual DB reserve must cover it. */
  maximumCallCostUsd: number;
}
export interface ConfiguredEvidenceStage {
  provider: StageProviderName;
  model: StageModelId;
  apiKey: string;
  baseUrl?: string;
  reasoningEffort: StageReasoningEffort;
  maxOutputTokens: number;
  attestation: StageModelAttestation;
}
export interface StageDeepPassConfig {
  stages: Partial<Record<DeepPassType, ConfiguredEvidenceStage>>;
  requestTimeoutMs: number;
  /** A reviewed fanout policy, never enabled merely by a credential. */
  regionalReview: { enabled: boolean; grid: 2 | 3 };
}

function unavailable(message: string): never { throw new ProjectApiError(503, `Full Takeoff stage configuration: ${message}`); }
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function readAttestations(value: string | undefined): Record<string, unknown> {
  if (!value || value.length > 16_384) unavailable('exact-model account, compatibility and price attestations are required.');
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { unavailable('model attestations must be valid JSON.'); }
  if (!record(parsed)) unavailable('model attestations must be a model-keyed object.');
  return parsed;
}
function attestationFor(input: Record<string, unknown>, model: StageModelId): StageModelAttestation {
  const value = input[model];
  if (!record(value) || value.accountVerified !== true || value.compatibilityVerified !== true
    || typeof value.priceVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{1,119}$/.test(value.priceVersion)
    || typeof value.maximumCallCostUsd !== 'number' || !Number.isFinite(value.maximumCallCostUsd)
    || value.maximumCallCostUsd <= 0 || value.maximumCallCostUsd > 100_000) {
    unavailable(`${model} needs exact-model account/compatibility verification and a reviewed maximum call cost.`);
  }
  return Object.freeze({ accountVerified: true, compatibilityVerified: true,
    priceVersion: value.priceVersion, maximumCallCostUsd: value.maximumCallCostUsd });
}
/** No filesystem/env reads and no implicit provider/model selection. */
export function requireStageDeepPassConfig(env: Record<string, string | undefined>): StageDeepPassConfig {
  if (env.TAKEOFF_V2_ENABLED !== 'true' || env.TAKEOFF_V2_WORKER_ENABLED !== 'true'
    || env.TAKEOFF_V2_STAGE_PROVIDER_ENABLED !== 'true'
    || env.TAKEOFF_V2_SCHEMA_VERSION !== 'takeoff-v2-foundation-v1') {
    unavailable('enablement, durable worker and reviewed schema are required.');
  }
  const timeout = env.TAKEOFF_V2_PROVIDER_TIMEOUT_MS === undefined ? 120_000 : Number(env.TAKEOFF_V2_PROVIDER_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 600_000) {
    unavailable('provider timeout must be an integer between 1000 and 600000 milliseconds.');
  }
  for (const pass of LOCAL_PASSES) {
    if (env[`TAKEOFF_V2_STAGE_${pass.toUpperCase()}_ENABLED`] === 'true') {
      unavailable(`${pass} is deterministic and cannot be delegated to a language model.`);
    }
  }
  const stages: Partial<Record<DeepPassType, ConfiguredEvidenceStage>> = {};
  let attestations: Record<string, unknown> | undefined;
  for (const pass of AI_EVIDENCE_PASSES) {
    const prefix = `TAKEOFF_V2_STAGE_${pass.toUpperCase()}`;
    const flag = env[`${prefix}_ENABLED`];
    if (flag !== undefined && flag !== 'true' && flag !== 'false' && flag !== '') unavailable(`${prefix}_ENABLED must be true or false.`);
    if (flag !== 'true') continue;
    const provider = env[`${prefix}_PROVIDER`]?.trim();
    if (provider !== 'openai' && provider !== 'claude' && provider !== 'gemini' && provider !== 'kimi' && provider !== 'deepseek') unavailable(`${pass} requires an explicit provider.`);
    const sharedModel = provider === 'openai' ? env.OPENAI_MODEL
      : provider === 'claude' ? env.TAKEOFF_V2_CLAUDE_MODEL ?? env.CLAUDE_PLAN_MODEL
      : provider === 'gemini' ? env.GEMINI_MODEL : provider === 'kimi' ? env.KIMI_VISION_MODEL : env.DEEPSEEK_VISION_MODEL;
    const model = (env[`${prefix}_MODEL`] ?? sharedModel)?.trim();
    if (!model || !Object.hasOwn(STAGE_MODEL_REGISTRY, model)
      || STAGE_MODEL_REGISTRY[model as StageModelId].provider !== provider) unavailable(`${pass} has an unsupported exact provider/model combination.`);
    const capability = STAGE_REASONING_CAPABILITIES[model as StageModelId];
    const effort = env[`${prefix}_REASONING_EFFORT`] ?? env[`TAKEOFF_V2_${provider.toUpperCase()}_REASONING_EFFORT`] ?? capability.maximum;
    if (!capability.levels.includes(effort as StageReasoningEffort)) unavailable(`${model} does not support the configured reasoning effort.`);
    const maxOutputTokens = Number(env[`${prefix}_MAX_OUTPUT_TOKENS`] ?? env.TAKEOFF_V2_PROVIDER_MAX_OUTPUT_TOKENS ?? capability.outputDefault);
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 4_096 || maxOutputTokens > capability.outputCeiling) {
      unavailable(`${model} output token budget must be between 4096 and ${capability.outputCeiling}.`);
    }
    const apiKey = (provider === 'openai' ? env.OPENAI_API_KEY : provider === 'claude' ? env.ANTHROPIC_API_KEY
      : provider === 'gemini' ? env.GEMINI_API_KEY : provider === 'kimi' ? env.KIMI_API_KEY : env.DEEPSEEK_API_KEY)?.trim();
    if (!isConfiguredValue(apiKey)) unavailable(`${pass} requires the manually configured ${provider} credential.`);
    let baseUrl: string | undefined;
    if (provider === 'kimi' || provider === 'deepseek') {
      if (env[`${provider.toUpperCase()}_PRIVATE_PLAN_DATA_APPROVED`] !== 'true') unavailable(`${provider} private-plan data processing must be approved explicitly.`);
      const configuredUrl = provider === 'kimi' ? env.KIMI_BASE_URL : env.DEEPSEEK_BASE_URL;
      baseUrl = requireImageProviderBaseUrl(provider, configuredUrl?.trim() || (provider === 'kimi' ? 'https://api.moonshot.ai/v1' : 'https://api.deepseek.com'));
    }
    attestations ??= readAttestations(env.TAKEOFF_V2_MODEL_ATTESTATIONS_JSON);
    stages[pass] = Object.freeze({ provider, model: model as StageModelId, apiKey, ...(baseUrl ? { baseUrl } : {}),
      reasoningEffort: effort as StageReasoningEffort, maxOutputTokens,
      attestation: attestationFor(attestations, model as StageModelId) });
  }
  if (!Object.keys(stages).length) unavailable('at least one evidence stage must be explicitly configured.');
  const regionalFlag = env.TAKEOFF_V2_REGIONAL_REVIEW_ENABLED;
  if (regionalFlag !== undefined && !['true', 'false', ''].includes(regionalFlag)) unavailable('regional review flag must be true or false.');
  const grid = Number(env.TAKEOFF_V2_REGION_GRID ?? 2);
  if (grid !== 2 && grid !== 3) unavailable('regional review grid must be 2 or 3.');
  return Object.freeze({ stages: Object.freeze(stages), requestTimeoutMs: timeout,
    regionalReview: Object.freeze({ enabled: regionalFlag === 'true', grid: grid as 2 | 3 }) });
}
