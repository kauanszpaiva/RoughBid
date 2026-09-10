import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { measureGeminiUsage } from '../../../../packages/domain/src/api-usage.ts';
interface Writer { from(table: string): any; rpc?(fn: string,args: Record<string,unknown>): PromiseLike<{data:unknown;error:{message?:string}|null}> }
interface Context { writer: Writer; userId: string; workspaceId: string; projectId: string; jobId: string; billing: 'paid' | 'verified_free' }
const storage = new AsyncLocalStorage<Context>();
export class UsageAccountingError extends Error {
  constructor() { super('API usage accounting is unavailable. No automatic retry is allowed; contact the platform owner.'); this.name = 'UsageAccountingError'; }
}
export class ProviderSpendLimitError extends UsageAccountingError {
  constructor() { super(); this.message = 'RoughBid reached its company AI spend limit. No provider request was sent; contact support to continue.'; this.name = 'ProviderSpendLimitError'; }
}
export function withUsageMeter<T>(context: Context, run: () => Promise<T>): Promise<T> { return storage.run(context, run); }
/** Called at the SDK boundary, before parsing any AI-generated document content. */
export async function meterGeminiCall<T>(model: string, kind: 'generate' | 'count_tokens', call: () => Promise<T>): Promise<T> {
  const context = storage.getStore();
  // Unit SDK adapters have no request scope. Production services always supply one.
  if (!context) return call();
  if (!context.userId || !context.workspaceId || !context.projectId || !context.jobId) throw new UsageAccountingError();
  const id = randomUUID();
  const prefix = `rb1:${context.jobId}:${kind}:`;
  let insert: { error: unknown };
  try { insert = await context.writer.from('api_usage_events').insert({ id, workspace_id: context.workspaceId,
    project_id: context.projectId, user_id: context.userId, provider: 'gemini', model, operation: `${prefix}pending`,
    input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0, actual_cost_usd: null, sensitive_payload: false }); } catch { throw new UsageAccountingError(); }
  if (insert.error) throw new UsageAccountingError();
  const settle = async (patch: Record<string, unknown>) => {
    try {
      const result = await context.writer.from('api_usage_events').update(patch).eq('id', id);
      if (result.error) throw new UsageAccountingError();
    } catch { throw new UsageAccountingError(); }
  };
  const captureSpend = async (estimatedCostUsd: number | null) => {
    if (kind !== 'generate') return;
    if (!context.writer.rpc) throw new UsageAccountingError();
    try {
      const result = await context.writer.rpc('capture_provider_spend', { p_event_id: id, p_estimated_cost_usd: estimatedCostUsd });
      if (result.error) throw new UsageAccountingError();
    } catch { throw new UsageAccountingError(); }
  };
  if (kind === 'generate') {
    if (!context.writer.rpc) throw new UsageAccountingError();
    let reservation: { error: { message?: string } | null };
    try {
      reservation = await context.writer.rpc('reserve_provider_spend', {
        p_event_id: id, p_job_id: context.jobId, p_workspace_id: context.workspaceId,
        p_user_id: context.userId, p_provider: 'gemini', p_model: model,
      });
    } catch { throw new UsageAccountingError(); }
    if (reservation.error) {
      if (/company ai spend limit reached/i.test(reservation.error.message ?? '')) {
        await settle({ operation: `${prefix}blocked_spend_limit` });
        throw new ProviderSpendLimitError();
      }
      throw new UsageAccountingError();
    }
  }
  let response: T;
  try { response = await call(); }
  catch (error) {
    await settle({ operation: `${prefix}failed_unknown` });
    await captureSpend(null);
    throw error;
  }
  const raw = response && typeof response === 'object' ? response as Record<string, unknown> : {};
  const measured = kind === 'generate' ? measureGeminiUsage(raw.usageMetadata, model) : null;
  // Application entitlement never proves that the provider call itself is free.
  // Owner-complimentary jobs therefore retain the same provider-cost estimate as
  // pilot/paid jobs unless independent billing reconciliation records actual cost.
  const state = kind === 'count_tokens' ? 'counted' : measured ? measured.estimatedCostUsd === null ? 'tokens_only' : 'measured' : 'unknown';
  // The old schema requires numeric counters. Only a measured state makes these
  // values reportable; pending/unknown zeros are placeholders, never $0 claims.
  await settle({ operation: `${prefix}${state}`, input_tokens: measured?.inputTokens ?? 0,
    output_tokens: measured?.outputTokens ?? 0, estimated_cost_usd: measured?.estimatedCostUsd ?? 0,
    actual_cost_usd: null,
    provider_request_id: typeof raw.responseId === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(raw.responseId) ? raw.responseId : null });
  await captureSpend(measured?.estimatedCostUsd ?? null);
  return response;
}
