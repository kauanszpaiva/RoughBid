import type { DeepCheckpointRepository, DeepPassProvider, DeepPassRequest, DeepPassResult, DeepPassType, PlanSetManifest } from './types.ts';

export const DEEP_PASS_ORDER: readonly DeepPassType[] = [
  'classification', 'legends_schedules', 'geometry', 'discipline', 'reconciliation',
  'conflict_detection', 'completeness', 'arithmetic_qa', 'pricing_assemblies', 'risk_review',
];

async function idempotencyKey(runId: string, page: number, passType: DeepPassType, attempt: number): Promise<string> {
  const bytes = new TextEncoder().encode(`${runId}:${page}:${passType}:${attempt}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export interface DeepSheetSummary {
  physicalPageNumber: number;
  status: 'reviewed' | 'review_required' | 'blocked';
  passesCompleted: number;
  passesTotal: number;
  blockers: string[];
}

export interface DeepRunSummary {
  attempted: number;
  succeeded: number;
  blocked: number;
  failed: number;
  /** Passes another live run already owns. They are never re-billed here. */
  claimed: number;
  sheets: DeepSheetSummary[];
}

/** Raised only by this module, so its text is safe to persist and return. */
export class DeepPassOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeepPassOutputError';
  }
}

export const REDACTED_PROVIDER_FAILURE =
  'The Full Takeoff provider call did not complete. Provider detail was withheld.';

/**
 * Provider and transport exception text is untrusted and may echo request or
 * response bodies, so only this module's own validation text survives.
 */
export function redactDeepPassFailure(error: unknown): { classification: string; message: string } {
  if (error instanceof DeepPassOutputError) {
    return { classification: 'invalid_output', message: error.message.slice(0, 300) };
  }
  return { classification: 'provider_or_pipeline_failure', message: REDACTED_PROVIDER_FAILURE };
}

function validatedPassResult(value: unknown): DeepPassResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DeepPassOutputError('Deep pass returned an invalid result object.');
  const input = value as Record<string, unknown>;
  if (input.status !== 'succeeded' && input.status !== 'blocked') throw new DeepPassOutputError('Deep pass returned an invalid status.');
  if (!input.checkpoint || typeof input.checkpoint !== 'object' || Array.isArray(input.checkpoint)) {
    throw new DeepPassOutputError('Deep pass returned an invalid checkpoint.');
  }
  let checkpointBytes: number;
  try { checkpointBytes = new TextEncoder().encode(JSON.stringify(input.checkpoint)).byteLength; }
  catch { throw new DeepPassOutputError('Deep pass checkpoint is not serializable.'); }
  if (checkpointBytes > 1_000_000) throw new DeepPassOutputError('Deep pass checkpoint exceeds 1 MB.');
  for (const field of ['provider', 'model'] as const) {
    const label = input[field];
    if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > 160)) {
      throw new DeepPassOutputError(`Deep pass returned invalid ${field} metadata.`);
    }
  }
  for (const field of ['inputTokens', 'outputTokens'] as const) {
    const tokenCount = input[field];
    if (tokenCount !== undefined && (!Number.isSafeInteger(tokenCount) || (tokenCount as number) < 0)) {
      throw new DeepPassOutputError(`Deep pass returned invalid ${field}.`);
    }
  }
  return value as DeepPassResult;
}

/**
 * Bounded, resumable FULL orchestration. A sheet/pass failure is persisted and
 * does not discard earlier checkpoints. Provider content is untrusted data;
 * the provider cannot change pass order, retry limits, or reasoning policy.
 */
export async function runDeepTakeoff(
  runId: string,
  manifest: PlanSetManifest,
  provider: DeepPassProvider,
  repository: DeepCheckpointRepository,
): Promise<DeepRunSummary> {
  if (!runId) throw new TypeError('runId is required.');
  if (manifest.physicalPageCount !== manifest.sheets.length) throw new Error('Manifest page count does not reconcile.');
  const summary: DeepRunSummary = { attempted: 0, succeeded: 0, blocked: 0, failed: 0, claimed: 0, sheets: [] };
  for (const sheet of manifest.sheets) {
    const sheetSummary: DeepSheetSummary = {
      physicalPageNumber: sheet.physicalPageNumber,
      status: 'review_required',
      passesCompleted: 0,
      passesTotal: DEEP_PASS_ORDER.length,
      blockers: [],
    };
    summary.sheets.push(sheetSummary);
    for (const passType of DEEP_PASS_ORDER) {
      const request: DeepPassRequest = {
        runId, sheet, passType, attempt: 1,
        idempotencyKey: await idempotencyKey(runId, sheet.physicalPageNumber, passType, 1),
        reasoningEffort: 'high',
      };
      const disposition = await repository.begin(request);
      if (disposition === 'already_claimed') {
        summary.claimed += 1;
        sheetSummary.status = 'blocked';
        sheetSummary.blockers.push(`${passType} pass is claimed by another Full Takeoff run.`);
        break;
      }
      if (disposition !== 'run') {
        sheetSummary.passesCompleted += 1;
        if (disposition === 'already_blocked') {
          summary.blocked += 1;
          sheetSummary.status = 'blocked';
          sheetSummary.blockers.push(`${passType} pass remains blocked.`);
        }
        continue;
      }
      summary.attempted += 1;
      try {
        const result = validatedPassResult(await provider.runPass(request));
        await repository.succeed(request, result);
        sheetSummary.passesCompleted += 1;
        if (result.status === 'blocked') {
          summary.blocked += 1;
          sheetSummary.status = 'blocked';
          sheetSummary.blockers.push(`${passType} pass is blocked.`);
        } else summary.succeeded += 1;
      } catch (error) {
        const failure = redactDeepPassFailure(error);
        summary.failed += 1;
        sheetSummary.status = 'blocked';
        sheetSummary.blockers.push(`${passType}: ${failure.message}`);
        await repository.fail(request, failure);
        break;
      }
    }
    if (sheetSummary.passesCompleted === sheetSummary.passesTotal && sheetSummary.blockers.length === 0) {
      sheetSummary.status = 'reviewed';
    }
  }
  return summary;
}
