import { ProjectApiError } from '../projects/service.ts';
import type { StageDeepPassConfig, StageProviderName } from './stage-config.ts';
import type { StageFactoryInput } from './stage-regions.ts';

export interface FullRunSpendLimit { provider: StageProviderName; models: string[]; approvedUsd: number; maximumCalls: number; approvalRef: string }
/** A reported account balance is never interpreted as authorization. */
export function requireFullRunSpendLimits(env: Record<string, string | undefined>, config: StageDeepPassConfig): FullRunSpendLimit[] {
  let value: unknown;
  try { value = JSON.parse(env.TAKEOFF_V2_RUN_SPEND_LIMITS_JSON ?? 'null'); } catch { value = null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProjectApiError(503,
    'Full Takeoff needs explicit reviewed per-provider run budgets. Available account credit is not spending approval.');
  const object = value as Record<string, unknown>, providers = [...new Set(Object.values(config.stages).map(stage => stage.provider))];
  return providers.map(provider => {
    const entry = object[provider];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ProjectApiError(503, `Full Takeoff budget for ${provider} is pending.`);
    const fields = entry as Record<string, unknown>;
    if (typeof fields.approvedUsd !== 'number' || !Number.isFinite(fields.approvedUsd) || fields.approvedUsd <= 0 || fields.approvedUsd > 100_000
      || !Number.isSafeInteger(fields.maximumCalls) || (fields.maximumCalls as number) < 1 || (fields.maximumCalls as number) > 100_000
      || typeof fields.approvalRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/ -]{2,199}$/.test(fields.approvalRef)) {
      throw new ProjectApiError(503, `Full Takeoff budget for ${provider} needs an amount, finite call policy and reviewed authorization reference.`);
    }
    const stages = Object.values(config.stages).filter(stage => stage.provider === provider);
    if (stages.some(stage => stage.attestation.maximumCallCostUsd > (fields.approvedUsd as number))) {
      throw new ProjectApiError(503, `One bounded ${provider} call exceeds its approved run exposure.`);
    }
    return { provider, models: [...new Set(stages.map(stage => stage.model))], approvedUsd: fields.approvedUsd,
      maximumCalls: fields.maximumCalls as number, approvalRef: fields.approvalRef };
  });
}
export async function configureFullRunSpendLimits(input: StageFactoryInput, limits: readonly FullRunSpendLimit[],
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>): Promise<void> {
  if (!input.leaseId) throw new Error('Run budget requires its current durable worker lease.');
  for (const limit of limits) {
    const saved = await rpc('configure_full_takeoff_run_budget', { p_run_id: input.runId, p_lease_id: input.leaseId,
      p_provider: limit.provider, p_models: limit.models, p_approved_usd: limit.approvedUsd,
      p_maximum_calls: limit.maximumCalls, p_approval_ref: limit.approvalRef });
    if (saved.error || saved.data !== true) throw new Error('The reviewed Full Takeoff run budget could not be persisted.');
  }
}
