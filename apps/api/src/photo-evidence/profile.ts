import { STAGE_MODEL_REGISTRY } from '../takeoff-v2/stage-config.ts';

export const PHOTO_EVIDENCE_STAGES = ['observation', 'reconciliation', 'risk_review'] as const;
export type PhotoEvidenceStage = typeof PHOTO_EVIDENCE_STAGES[number];
export type MaximumPhotoModel = 'gpt-6-astra' | 'claude-opus-5-5' | 'gemini-3.1-pro-preview';
export type PhotoProviderName = 'openai' | 'claude' | 'gemini';

export class PhotoEvidenceError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Photo evidence is unavailable: ${code}.`);
    this.name = 'PhotoEvidenceError';
    this.code = code;
  }
}

export interface PhotoStageRoute {
  provider: PhotoProviderName;
  model: MaximumPhotoModel;
  accountVerified: true;
  imageCompatibilityVerified: true;
  priceVersion: string;
  maximumCallCostUsd: number;
}
export interface PhotoEvidenceProfile {
  enabled: true;
  quality: 'maximum';
  routes: Readonly<Record<PhotoEvidenceStage, Readonly<PhotoStageRoute>>>;
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const MAXIMUM_MODELS = new Set<string>(['gpt-6-astra', 'claude-opus-5-5', 'gemini-3.1-pro-preview']);

/** Pure, closed-by-default configuration. No credentials, env reads or model fallback. */
export function requirePhotoEvidenceProfile(input: unknown): PhotoEvidenceProfile {
  if (!record(input) || input.enabled !== true) throw new PhotoEvidenceError('photo_processing_disabled');
  if (input.quality !== 'maximum' || !record(input.routes)) throw new PhotoEvidenceError('maximum_quality_configuration_required');
  const routes = {} as Record<PhotoEvidenceStage, Readonly<PhotoStageRoute>>;
  for (const stage of PHOTO_EVIDENCE_STAGES) {
    const route = input.routes[stage];
    if (!record(route) || typeof route.model !== 'string' || !MAXIMUM_MODELS.has(route.model)) {
      throw new PhotoEvidenceError('explicit_maximum_quality_model_required');
    }
    const model = route.model as MaximumPhotoModel;
    if (STAGE_MODEL_REGISTRY[model].provider !== route.provider || route.accountVerified !== true
      || route.imageCompatibilityVerified !== true || typeof route.priceVersion !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{1,119}$/.test(route.priceVersion)
      || typeof route.maximumCallCostUsd !== 'number' || !Number.isFinite(route.maximumCallCostUsd)
      || route.maximumCallCostUsd <= 0 || route.maximumCallCostUsd > 100_000) {
      throw new PhotoEvidenceError('photo_model_account_image_and_price_verification_required');
    }
    routes[stage] = Object.freeze({ provider: route.provider as PhotoProviderName, model,
      accountVerified: true, imageCompatibilityVerified: true, priceVersion: route.priceVersion,
      maximumCallCostUsd: route.maximumCallCostUsd });
  }
  return Object.freeze({ enabled: true, quality: 'maximum', routes: Object.freeze(routes) });
}
