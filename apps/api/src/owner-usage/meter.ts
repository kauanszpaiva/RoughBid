import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { measureGeminiUsage } from '../../../../packages/domain/src/api-usage.ts';
interface Writer { from(table: string): any }
interface Context { writer: Writer; userId: string; workspaceId: string; projectId: string; jobId: string; billing: 'paid' | 'verified_free' }
const storage = new AsyncLocalStorage<Context>();
export class UsageAccountingError extends Error {
  constructor() { super('API usage accounting is unavailable. No automatic retry is allowed; contact the platform owner.'); this.name = 'UsageAccountingError'; }
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
  let response: T;
  try { response = await call(); }
  catch (error) {
    await settle({ operation: `${prefix}failed_unknown` });
    throw error;
  }
  const raw = response && typeof response === 'object' ? response as Record<string, unknown> : {};
  const measured = kind === 'generate' ? measureGeminiUsage(raw.usageMetadata, model) : null;
  const free = context.billing === 'verified_free';
  const state = kind === 'count_tokens' ? 'counted' : measured ? free ? 'verified_free' : measured.estimatedCostUsd === null ? 'tokens_only' : 'measured' : 'unknown';
  // The old schema requires numeric counters. Only a measured state makes these
  // values reportable; pending/unknown zeros are placeholders, never $0 claims.
  await settle({ operation: `${prefix}${state}`, input_tokens: measured?.inputTokens ?? 0,
    output_tokens: measured?.outputTokens ?? 0, estimated_cost_usd: free ? 0 : measured?.estimatedCostUsd ?? 0,
    actual_cost_usd: null,
    provider_request_id: typeof raw.responseId === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(raw.responseId) ? raw.responseId : null });
  return response;
}
