import { createHash } from 'node:crypto';
import { ProjectApiError } from '../projects/service.ts';
import { requireStageDeepPassConfig, type StageProviderName } from './stage-config.ts';
import { requireFullRunSpendLimits, type FullRunSpendLimit } from './run-spend-policy.ts';

export interface FullTakeoffApprovalProfile {
  version: 'full-user-spend-v1';
  policyId: string;
  providers: Array<{ provider: StageProviderName; models: string[]; minimumUsd: number; maximumUsd: number; maximumCalls: number }>;
}
export interface FullTakeoffSpendApproval {
  version: 'full-user-spend-v1';
  policyId: string;
  approvedBy: string;
  providers: Array<{ provider: StageProviderName; models: string[]; approvedUsd: number }>;
}

/** Configuration is an operating ceiling, never a user's authorization to spend. */
export function fullTakeoffApprovalProfile(env: Record<string, string | undefined>): FullTakeoffApprovalProfile {
  const config = requireStageDeepPassConfig(env);
  const limits = requireFullRunSpendLimits(env, config);
  const reservationUsd = Number(env.TAKEOFF_V2_CALL_RESERVATION_USD);
  if (!Number.isFinite(reservationUsd) || reservationUsd <= 0 || reservationUsd > 100_000) {
    throw new ProjectApiError(503, 'The existing company per-call reservation must be reviewed before approving a reading.');
  }
  // Automatic geometry has its own commercial/data gates and is not covered by
  // the model-only consent shown here. Do not silently add a second vendor bill.
  if (env.GEOMETRY_PROVIDER_ENABLED === 'true' && env.TAKEOFF_V2_KAMAI_ENABLED === 'true') {
    throw new ProjectApiError(503, 'Automatic geometry requires a separate per-job authorization profile. No reading was started.');
  }
  const providers = limits.map(limit => ({ provider: limit.provider, models: [...limit.models].sort(),
    minimumUsd: Math.max(reservationUsd, ...Object.values(config.stages).filter(stage => stage.provider === limit.provider).map(stage => stage.attestation.maximumCallCostUsd)),
    maximumUsd: limit.approvedUsd, maximumCalls: limit.maximumCalls })).sort((a, b) => a.provider.localeCompare(b.provider));
  if (providers.some(provider => provider.minimumUsd > provider.maximumUsd)) {
    throw new ProjectApiError(503, 'A bounded provider call exceeds the configured run ceiling.');
  }
  const stages = Object.entries(config.stages).sort(([a], [b]) => a.localeCompare(b)).map(([name, stage]) => ({
    name, provider: stage.provider, model: stage.model, baseUrl: stage.baseUrl, reasoningEffort: stage.reasoningEffort,
    requestPolicy: stage.requestPolicy,
    maxOutputTokens: stage.maxOutputTokens, attestation: stage.attestation,
  }));
  const policyId = createHash('sha256').update(JSON.stringify({ providers, stages, regionalReview: config.regionalReview })).digest('hex');
  return { version: 'full-user-spend-v1', policyId, providers };
}

export function approveFullTakeoffSpend(input: unknown, profile: FullTakeoffApprovalProfile, userId: string): FullTakeoffSpendApproval {
  const value = input as { confirmed?: unknown; policyId?: unknown; budgetsUsd?: unknown } | null;
  if (!value || value.confirmed !== true || value.policyId !== profile.policyId || !value.budgetsUsd
    || typeof value.budgetsUsd !== 'object' || Array.isArray(value.budgetsUsd)) {
    throw new ProjectApiError(400, 'Review the current providers, enter each USD limit, and explicitly approve this reading.');
  }
  const budgets = value.budgetsUsd as Record<string, unknown>;
  if (Object.keys(budgets).length !== profile.providers.length || Object.keys(budgets).some(key => !profile.providers.some(provider => provider.provider === key))) {
    throw new ProjectApiError(400, 'Approve exactly the providers shown for this reading.');
  }
  return { version: profile.version, policyId: profile.policyId, approvedBy: userId,
    providers: profile.providers.map(provider => {
      const amount = budgets[provider.provider];
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < provider.minimumUsd || amount > provider.maximumUsd
        || Math.abs(amount * 1_000_000 - Math.round(amount * 1_000_000)) > 0.00001) {
        throw new ProjectApiError(400, `Choose a valid ${provider.provider} spending limit within the displayed range.`);
      }
      return { provider: provider.provider, models: [...provider.models], approvedUsd: amount };
    }) };
}

/** Revalidate saved consent against this worker's exact profile before any reservation. */
export function userApprovedFullRunLimits(approval: FullTakeoffSpendApproval | undefined,
  profile: FullTakeoffApprovalProfile, limits: readonly FullRunSpendLimit[]): FullRunSpendLimit[] {
  if (!approval || approval.version !== profile.version || !approval.approvedBy || approval.policyId !== profile.policyId
    || !Array.isArray(approval.providers) || approval.providers.length !== profile.providers.length) {
    throw new Error('Explicit user approval for the current Full Takeoff profile is required.');
  }
  const verified = approveFullTakeoffSpend({ confirmed: true, policyId: approval.policyId,
    budgetsUsd: Object.fromEntries(approval.providers.map(provider => [provider.provider, provider.approvedUsd])) }, profile, approval.approvedBy);
  // PostgreSQL JSONB reorders object keys. Compare the approved values, never
  // their serialization order, while still rejecting extra fields and models.
  if (verified.providers.some((provider, index) => {
    const saved = approval.providers[index];
    return !saved || Object.keys(saved).length !== 3
      || saved.provider !== provider.provider || saved.approvedUsd !== provider.approvedUsd
      || !Array.isArray(saved.models) || saved.models.length !== provider.models.length
      || saved.models.some((model, modelIndex) => model !== provider.models[modelIndex]);
  })) throw new Error('Saved provider/model approval does not match this worker.');
  return limits.map(limit => {
    const user = verified.providers.find(provider => provider.provider === limit.provider);
    if (!user || user.approvedUsd > limit.approvedUsd) throw new Error('User approval exceeds the configured provider ceiling.');
    return { ...limit, approvedUsd: user.approvedUsd, approvalRef: `user-job-v1:${approval.approvedBy}` };
  });
}
