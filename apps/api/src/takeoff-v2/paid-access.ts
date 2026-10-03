import { isPlatformAdmin } from '../access/platform-admin.ts';
import { hashPaidFullContract, validatePaidFullContract, type PaidFullContract } from '../billing/full-takeoff-pricing.ts';
import type { PlanReadingFindingsWriter } from '../ai-plan/service.ts';
import { ProjectApiError, type SupabaseLike } from '../projects/service.ts';
import type { PlanSetManifest } from './types.ts';
import { requireFullRunSpendLimits, type FullRunSpendLimit } from './run-spend-policy.ts';
import { requireStageDeepPassConfig } from './stage-config.ts';
import { fullTakeoffApprovalProfile, userApprovedFullRunLimits } from './user-spend-approval.ts';

export interface PaidFullAuthorization {
  quoteId: string;
  paymentRevision: number;
  contractHash: string;
  approvedBy: string;
  contract: PaidFullContract;
}

/** A saved paid run cannot fall back to the caller's complimentary privilege. */
export async function assertFullTakeoffRunAccess(db: SupabaseLike, writer: PlanReadingFindingsWriter,
  runId: string, userId: string, workspaceId: string): Promise<void> {
  const found = await db.from('takeoff_runs').select('id,payment_kind').eq('id', runId).eq('workspace_id', workspaceId).maybeSingle();
  if (found.error) throw new ProjectApiError(503, 'Could not verify Full Takeoff access.');
  if (!found.data) throw new ProjectApiError(404, 'Full Takeoff run not found.');
  if (found.data.payment_kind === 'paid') {
    if (!writer.rpc) throw new ProjectApiError(503, 'Paid Full authorization is unavailable.');
    const result = await writer.rpc('full_takeoff_run_access', { p_run_id: runId, p_user_id: userId, p_workspace_id: workspaceId });
    if (result.error || result.data !== true) throw new ProjectApiError(403, 'Paid Full access is unavailable or has been revoked.');
  } else if (!await isPlatformAdmin(db, userId)) {
    throw new ProjectApiError(403, 'Full Takeoff V2 is not enabled for this account.');
  }
}

/** Validates the same immutable economic/technical contract on API and worker. */
export function paidFullRunLimits(manifest: PlanSetManifest, env: Record<string, string | undefined>): FullRunSpendLimit[] {
  const saved = manifest.paidAuthorization;
  if (!saved || !saved.approvedBy || !saved.quoteId || !Number.isSafeInteger(saved.paymentRevision) || saved.paymentRevision < 1) {
    throw new Error('Paid Full authorization is missing.');
  }
  const contract = validatePaidFullContract(saved.contract, env);
  if (hashPaidFullContract(contract) !== saved.contractHash || contract.manifest.fileSha256 !== manifest.fileSha256
    || contract.manifest.physicalPageCount !== manifest.physicalPageCount
    || contract.manifest.sheets.some((sheet, index) => sheet.pageSha256 !== manifest.sheets[index]?.pageSha256)) {
    throw new Error('Paid Full purchase does not match the saved plan revision.');
  }
  return contract.providers.map(provider => ({ ...provider, models: [...provider.models],
    approvalRef: `${contract.version}:${saved.quoteId}:${saved.paymentRevision}` }));
}

/** Startup validates capabilities; each run supplies its own spending authority. */
export function createFullTakeoffRunSpendPolicy(env: Record<string, string | undefined>): (manifest: PlanSetManifest) => FullRunSpendLimit[] {
  requireStageDeepPassConfig(env);
  return manifest => {
    // A paid contract never inherits or falls back to complimentary approval.
    if (manifest.paidAuthorization) return paidFullRunLimits(manifest, env);
    const limits = requireFullRunSpendLimits(env, requireStageDeepPassConfig(env));
    return userApprovedFullRunLimits(manifest.spendApproval, fullTakeoffApprovalProfile(env), limits);
  };
}
