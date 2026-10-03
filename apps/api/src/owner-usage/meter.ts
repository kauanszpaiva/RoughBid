import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { measureGeminiUsage } from '../../../../packages/domain/src/api-usage.ts';
interface Writer { from(table: string): any; rpc?(fn: string,args: Record<string,unknown>): PromiseLike<{data:unknown;error:{message?:string}|null}> }
interface Context { writer: Writer; userId: string; workspaceId: string; projectId: string; jobId: string; billing: 'paid' | 'verified_free';
  reservedExecution?: (provider: string, model: string, kind: string, call: () => Promise<unknown>) => Promise<unknown> }
const storage = new AsyncLocalStorage<Context>();
export class UsageAccountingError extends Error {
  constructor() { super('API usage accounting is unavailable. No automatic retry is allowed; contact the platform owner.'); this.name = 'UsageAccountingError'; }
}
export class ProviderSpendLimitError extends UsageAccountingError {
  readonly scope: 'company' | 'run';
  readonly eventId: string | undefined;
  constructor(scope: 'company' | 'run' = 'company', eventId?: string) { super(); this.scope = scope; this.eventId = eventId;
    this.message = scope === 'run' ? 'RoughBid reached this run/provider spending authorization. No provider request was sent; review its budget before continuing.'
      : 'RoughBid reached its company AI spend limit. No provider request was sent; contact support to continue.'; this.name = 'ProviderSpendLimitError'; }
}
export function withUsageMeter<T>(context: Context, run: () => Promise<T>): Promise<T> { return storage.run(context, run); }
/** Internal bridge executor only: its DB operation already owns the SAME event/reservation.
 * The supplied hook must fence exactly one provider transport; it cannot be provided by HTTP input. */
export function withReservedProviderExecution<T>(context: Omit<Context, 'reservedExecution'>,
  execute: NonNullable<Context['reservedExecution']>, run: () => Promise<T>): Promise<T> {
  return storage.run({ ...context, reservedExecution: execute }, run);
}
export interface ProviderSpendRequirement {
  minimumReservationUsd: number;
  /** Runs after the SAME financial reservation, immediately before transport. */
  beforeDispatch?: (eventId: string) => Promise<void>;
  /** Internal reviewed adapter only; same event/capture, never client supplied pricing. */
  reviewedTelemetry?: (response: unknown) => ReviewedProviderTelemetry | null;
}
export interface ReviewedProviderTelemetry {
  inputTokens: number; outputTokens: number; estimatedCostUsd: number | null; providerRequestId?: string | null;
}
function readReviewedTelemetry(response:unknown,requirement?:ProviderSpendRequirement):ReviewedProviderTelemetry|null {
  try {
    const value=requirement?.reviewedTelemetry?.(response);
    if(!value||!Number.isSafeInteger(value.inputTokens)||value.inputTokens<0||!Number.isSafeInteger(value.outputTokens)||value.outputTokens<0
      ||value.estimatedCostUsd!==null&&(!Number.isFinite(value.estimatedCostUsd)||value.estimatedCostUsd<0))return null;
    return {...value,providerRequestId:typeof value.providerRequestId==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test(value.providerRequestId)?value.providerRequestId:null};
  }catch{return null;}
}
/** New durable providers must never inherit the legacy no-context test shortcut. */
export function assertUsageMeterContext(expected?: { jobId: string; workspaceId: string; projectId: string }): void {
  const context = storage.getStore();
  if (!context?.userId || !context.workspaceId || !context.projectId || !context.jobId || !context.writer.rpc) {
    throw new UsageAccountingError();
  }
  if (expected && (expected.jobId !== context.jobId || expected.workspaceId !== context.workspaceId || expected.projectId !== context.projectId)) {
    throw new UsageAccountingError();
  }
}
function requireReservation(data: unknown, requirement?: ProviderSpendRequirement): void {
  if (!requirement) return;
  const reserved = data && typeof data === 'object' ? (data as Record<string, unknown>).reserved_usd : null;
  const amount = typeof reserved === 'number' ? reserved : typeof reserved === 'string' && reserved.trim() ? Number(reserved) : NaN;
  if (!Number.isFinite(requirement.minimumReservationUsd) || requirement.minimumReservationUsd <= 0
    || !Number.isFinite(amount) || amount < requirement.minimumReservationUsd) throw new UsageAccountingError();
}
/** Called at the SDK boundary, before parsing any AI-generated document content. */
export async function meterGeminiCall<T>(model: string, kind: 'generate' | 'count_tokens', call: () => Promise<T>, requirement?: ProviderSpendRequirement): Promise<T> {
  if (requirement) assertUsageMeterContext();
  const context = storage.getStore();
  // Unit SDK adapters have no request scope. Production services always supply one.
  if (!context) return call();
  if (!context.userId || !context.workspaceId || !context.projectId || !context.jobId) throw new UsageAccountingError();
  if (context.reservedExecution) return context.reservedExecution('gemini', model, kind, call) as Promise<T>;
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
    let reservation: { data?: unknown; error: { message?: string } | null };
    try {
      reservation = await context.writer.rpc('reserve_provider_spend', {
        p_event_id: id, p_job_id: context.jobId, p_workspace_id: context.workspaceId,
        p_user_id: context.userId, p_provider: 'gemini', p_model: model,
        ...(requirement ? { p_required_reservation_usd: requirement.minimumReservationUsd } : {}),
      });
    } catch { throw new UsageAccountingError(); }
    if (reservation.error) {
      if (/(?:company ai spend limit|provider run spend limit) reached/i.test(reservation.error.message ?? '')) {
        await settle({ operation: `${prefix}blocked_spend_limit` });
        throw new ProviderSpendLimitError(/provider run spend limit/i.test(reservation.error.message ?? '') ? 'run' : 'company', id);
      }
      throw new UsageAccountingError();
    }
    requireReservation(reservation.data, requirement);
    await requirement?.beforeDispatch?.(id);
  }
  let response: T;
  try { response = await call(); }
  catch (error) {
    await settle({ operation: `${prefix}failed_unknown` });
    await captureSpend(null);
    throw error;
  }
  const raw = response && typeof response === 'object' ? response as Record<string, unknown> : {};
  const reviewed=requirement?.reviewedTelemetry?readReviewedTelemetry(response,requirement):null;
  const measured = kind === 'generate' ? requirement?.reviewedTelemetry?reviewed:measureGeminiUsage(raw.usageMetadata, model) : null;
  const requestId=requirement?.reviewedTelemetry?reviewed?.providerRequestId:raw.responseId;
  // Application entitlement never proves that the provider call itself is free.
  // Owner-complimentary jobs therefore retain the same provider-cost estimate as
  // pilot/paid jobs unless independent billing reconciliation records actual cost.
  const state = kind === 'count_tokens' ? 'counted' : measured ? measured.estimatedCostUsd === null ? 'tokens_only' : 'measured' : 'unknown';
  // The old schema requires numeric counters. Only a measured state makes these
  // values reportable; pending/unknown zeros are placeholders, never $0 claims.
  await settle({ operation: `${prefix}${state}`, input_tokens: measured?.inputTokens ?? 0,
    output_tokens: measured?.outputTokens ?? 0, estimated_cost_usd: measured?.estimatedCostUsd ?? 0,
    actual_cost_usd: null,
    provider_request_id: typeof requestId === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(requestId) ? requestId : null });
  await captureSpend(measured?.estimatedCostUsd ?? null);
  return response;
}


export type MeteredVisionProvider = 'deepseek' | 'kimi' | 'openai';
export type MeteredMessagesProvider = 'claude';

interface ProviderCallTelemetry { inputTokens: number; outputTokens: number; requestId: string | null }

/**
 * Shared metering core for OpenAI-compatible vision providers and Anthropic
 * Messages. Provider token usage is recorded, but cost remains
 * telemetry-unknown until a provider-specific, versioned price calculator is
 * installed. In that state the database breaker conservatively retains the
 * configured per-call reservation.
 */
async function meterProviderCall<T>(provider: string, model: string, call: () => Promise<T>, readTelemetry: (response: T) => ProviderCallTelemetry, requirement?: ProviderSpendRequirement): Promise<T> {
  if (requirement) assertUsageMeterContext();
  const context = storage.getStore();
  if (!context) return call();
  if (!context.userId || !context.workspaceId || !context.projectId || !context.jobId) throw new UsageAccountingError();

  if (context.reservedExecution) return context.reservedExecution(provider, model, 'generate', call) as Promise<T>;

  const id = randomUUID();
  const prefix = `rb1:${context.jobId}:generate:`;
  let insert: { error: unknown };
  try {
    insert = await context.writer.from('api_usage_events').insert({
      id,
      workspace_id: context.workspaceId,
      project_id: context.projectId,
      user_id: context.userId,
      provider,
      model,
      operation: `${prefix}pending`,
      input_tokens: 0,
      output_tokens: 0,
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      sensitive_payload: false,
    });
  } catch { throw new UsageAccountingError(); }
  if (insert.error) throw new UsageAccountingError();

  const settle = async (patch: Record<string, unknown>) => {
    try {
      const result = await context.writer.from('api_usage_events').update(patch).eq('id', id);
      if (result.error) throw new UsageAccountingError();
    } catch { throw new UsageAccountingError(); }
  };

  if (!context.writer.rpc) throw new UsageAccountingError();
  let reservation: { data?: unknown; error: { message?: string } | null };
  try {
    reservation = await context.writer.rpc('reserve_provider_spend', {
      p_event_id: id,
      p_job_id: context.jobId,
      p_workspace_id: context.workspaceId,
      p_user_id: context.userId,
      p_provider: provider,
      p_model: model,
      ...(requirement ? { p_required_reservation_usd: requirement.minimumReservationUsd } : {}),
    });
  } catch { throw new UsageAccountingError(); }
  if (reservation.error) {
    if (/(?:company ai spend limit|provider run spend limit) reached/i.test(reservation.error.message ?? '')) {
      await settle({ operation: `${prefix}blocked_spend_limit` });
      throw new ProviderSpendLimitError(/provider run spend limit/i.test(reservation.error.message ?? '') ? 'run' : 'company', id);
    }
    throw new UsageAccountingError();
  }
  requireReservation(reservation.data, requirement);
  await requirement?.beforeDispatch?.(id);

  let response: T;
  try { response = await call(); }
  catch (error) {
    await settle({ operation: `${prefix}failed_unknown` });
    try {
      const captured = await context.writer.rpc('capture_provider_spend', { p_event_id: id, p_estimated_cost_usd: null });
      if (captured.error) throw new UsageAccountingError();
    } catch { throw new UsageAccountingError(); }
    throw error;
  }

  const reviewed=requirement?.reviewedTelemetry?readReviewedTelemetry(response,requirement):null;
  const { inputTokens, outputTokens, requestId } = requirement?.reviewedTelemetry
    ?{inputTokens:reviewed?.inputTokens??0,outputTokens:reviewed?.outputTokens??0,requestId:reviewed?.providerRequestId??null}:readTelemetry(response);
  const estimatedCostUsd=reviewed?.estimatedCostUsd??null;
  await settle({
    operation: `${prefix}${estimatedCostUsd!==null?'measured':requirement?.reviewedTelemetry&&!reviewed?'unknown':'tokens_only'}`,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    estimated_cost_usd: estimatedCostUsd??0,
    actual_cost_usd: null,
    provider_request_id: requestId && /^[A-Za-z0-9_.:-]{1,200}$/.test(requestId) ? requestId : null,
  });
  try {
    const captured = await context.writer.rpc('capture_provider_spend', { p_event_id: id, p_estimated_cost_usd: estimatedCostUsd });
    if (captured.error) throw new UsageAccountingError();
  } catch { throw new UsageAccountingError(); }
  return response;
}

export async function meterOpenAiCompatibleCall<T extends { usage?: { prompt_tokens?: number; completion_tokens?: number }; id?: string }>(
  provider: MeteredVisionProvider,
  model: string,
  call: () => Promise<T>,
  requirement?: ProviderSpendRequirement,
): Promise<T> {
  return meterProviderCall(provider, model, call, response => ({
    inputTokens: Number.isSafeInteger(response.usage?.prompt_tokens) ? response.usage!.prompt_tokens! : 0,
    outputTokens: Number.isSafeInteger(response.usage?.completion_tokens) ? response.usage!.completion_tokens! : 0,
    requestId: typeof response.id === 'string' ? response.id : null,
  }), requirement);
}

/** Anthropic Messages usage is reported per side of the call, not as prompt/completion tokens. */
export async function meterAnthropicCall<T extends { usage?: { inputTokens?: number; outputTokens?: number }; id?: string }>(
  provider: MeteredMessagesProvider,
  model: string,
  call: () => Promise<T>,
  requirement?: ProviderSpendRequirement,
): Promise<T> {
  return meterProviderCall(provider, model, call, response => ({
    inputTokens: Number.isSafeInteger(response.usage?.inputTokens) ? response.usage!.inputTokens! : 0,
    outputTokens: Number.isSafeInteger(response.usage?.outputTokens) ? response.usage!.outputTokens! : 0,
    requestId: typeof response.id === 'string' ? response.id : null,
  }), requirement);
}
