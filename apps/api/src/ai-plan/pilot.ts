import { ProjectApiError } from '../projects/service.ts';

export interface PilotExecution {
  attempt: number;
  model: string;
  max_input_tokens: number;
  max_output_tokens: number;
  reserved_usd: number;
}

/** Provider-reported tokens; USD is computed by the private ledger's pinned tariff. */
export interface ProviderUsage {
  model: string;
  model_version: string;
  input_tokens: number;
  output_tokens: number;
}
export type UsageEvent = { outcome: 'unknown' | 'no_provider' } | { outcome: 'measured'; usage: ProviderUsage };

function decimalAmount(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return NaN;
}

export async function assertPilotAccess(db: { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: any }> }, workspaceId: string, model: string) {
  const result = await db.rpc('assert_plan_reading_activation', { p_workspace_id: workspaceId, p_model: model });
  if (result.error || !result.data?.enabled || result.data.model !== model || result.data.stripe_livemode !== false) {
    throw new ProjectApiError(503, 'Paid plan analysis is not enabled for this workspace.');
  }
  const budget = decimalAmount(result.data.budget_usd);
  const exposure = decimalAmount(result.data.exposure_usd);
  const reserve = decimalAmount(result.data.reserved_usd_per_attempt);
  if (!Number.isFinite(budget) || budget <= 0 || !Number.isFinite(exposure) || exposure < 0
    || !Number.isFinite(reserve) || reserve <= 0 || exposure + reserve > budget) {
    throw new ProjectApiError(503, 'The pilot spending budget is unavailable or exhausted.');
  }
  return result.data;
}

export function requirePilotExecution(value: unknown): PilotExecution {
  const p = value as PilotExecution | null;
  if (!p || !Number.isSafeInteger(p.attempt) || p.attempt < 1 || p.attempt > 2
    || typeof p.model !== 'string' || !p.model || /(?:latest|preview|experimental)/i.test(p.model)
    || !Number.isSafeInteger(p.max_input_tokens) || p.max_input_tokens < 1
    || !Number.isSafeInteger(p.max_output_tokens) || p.max_output_tokens < 1 || p.max_output_tokens > 8000
    || !Number.isFinite(decimalAmount(p.reserved_usd)) || decimalAmount(p.reserved_usd) <= 0) {
    throw new ProjectApiError(503, 'Pilot spending authorization is unavailable. No AI processing was started.');
  }
  return p;
}

export function readProviderUsage(response: {
  modelVersion?: string;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; toolUsePromptTokenCount?: number; totalTokenCount?: number };
}, model: string): ProviderUsage | null {
  const u = response.usageMetadata;
  if (!u || !Number.isSafeInteger(u.promptTokenCount) || u.promptTokenCount! <= 0
    || !Number.isSafeInteger(u.candidatesTokenCount) || u.candidatesTokenCount! < 0
    || !Number.isSafeInteger(u.thoughtsTokenCount ?? 0) || (u.thoughtsTokenCount ?? 0) < 0
    || (u.toolUsePromptTokenCount ?? 0) !== 0) return null;
  const output = u.candidatesTokenCount! + (u.thoughtsTokenCount ?? 0);
  if (!Number.isSafeInteger(output) || (u.totalTokenCount !== undefined && u.totalTokenCount !== u.promptTokenCount! + output)) return null;
  // Cached input is included at the full input tariff, conservatively. No raw PDF/prompt is retained here.
  return { model, model_version: response.modelVersion?.trim() || 'unreported', input_tokens: u.promptTokenCount!, output_tokens: output };
}
