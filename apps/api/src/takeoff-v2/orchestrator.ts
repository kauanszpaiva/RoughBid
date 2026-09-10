import type { DeepCheckpointRepository, DeepPassProvider, DeepPassRequest, DeepPassType, PlanSetManifest } from './types.ts';

export const DEEP_PASS_ORDER: readonly DeepPassType[] = [
  'classification', 'legends_schedules', 'geometry', 'discipline', 'reconciliation',
  'conflict_detection', 'completeness', 'arithmetic_qa', 'pricing_assemblies', 'risk_review',
];

async function idempotencyKey(runId: string, page: number, passType: DeepPassType, attempt: number): Promise<string> {
  const bytes = new TextEncoder().encode(`${runId}:${page}:${passType}:${attempt}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export interface DeepRunSummary { attempted: number; succeeded: number; blocked: number; failed: number; }

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
  const summary: DeepRunSummary = { attempted: 0, succeeded: 0, blocked: 0, failed: 0 };
  for (const sheet of manifest.sheets) {
    for (const passType of DEEP_PASS_ORDER) {
      const request: DeepPassRequest = {
        runId, sheet, passType, attempt: 1,
        idempotencyKey: await idempotencyKey(runId, sheet.physicalPageNumber, passType, 1),
        reasoningEffort: 'high',
      };
      if (await repository.begin(request) === 'already_succeeded') continue;
      summary.attempted += 1;
      try {
        const result = await provider.runPass(request);
        await repository.succeed(request, result);
        if (result.status === 'blocked') summary.blocked += 1;
        else summary.succeeded += 1;
      } catch (error) {
        summary.failed += 1;
        await repository.fail(request, {
          classification: error instanceof SyntaxError ? 'invalid_output' : 'provider_or_pipeline_failure',
          message: (error instanceof Error ? error.message : 'Unknown failure').slice(0, 1000),
        });
        break;
      }
    }
  }
  return summary;
}
