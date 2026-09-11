import { ProjectApiError, assertPlanStoragePath, type SupabaseLike } from '../projects/service.ts';
import { hasPlatformAdminProjectAccess } from '../access/platform-admin.ts';
import { downloadPlan, inspectPdf, normalizeScope, PDF_DIGEST } from '../billing/project-preflight.ts';
import type { AiPlanObjectStorage } from './service.ts';

/** Read-only inventory. Loading/resuming the screen never invokes a model. */
export async function getPageReadingInventory(
  db: SupabaseLike, storage: AiPlanObjectStorage, userId: string,
  workspaceId: string, projectId: string, fileId: string,
  input: Record<string, unknown>, fetcher: typeof fetch = fetch,
) {
  if (!await hasPlatformAdminProjectAccess(db, userId, workspaceId, projectId)) {
    throw new ProjectApiError(403, 'Page-by-page review is available only to the platform owner in an authorized workspace.');
  }
  if (!fileId) throw new ProjectApiError(400, 'file_id is required');
  const scope = normalizeScope(input);
  const { data: file, error } = await db.from('project_files')
    .select('id,storage_path,processing_status').eq('id', fileId)
    .eq('workspace_id', workspaceId).eq('project_id', projectId).maybeSingle();
  if (error) throw new ProjectApiError(503, 'The PDF inventory is unavailable.');
  if (!file) throw new ProjectApiError(404, 'Plan file not found.');
  if (['uploading','failed'].includes(file.processing_status)) throw new ProjectApiError(409, 'Finish the PDF upload first.');
  assertPlanStoragePath(file.storage_path, workspaceId, projectId, fileId);
  const signed = await storage.presign('GET', file.storage_path, { expiresIn: 300 });
  const bytes = await downloadPlan(signed.url, fetcher);
  const { pages } = await inspectPdf(bytes);
  if (pages > 200) throw new ProjectApiError(413, 'Page-by-page review supports at most 200 physical pages per PDF. No pages were omitted silently.');
  const sha256 = PDF_DIGEST(bytes);
  const response = await db.from('plan_reading_jobs')
    .select('id,status,processing_error,input_summary,output_summary,model,created_at')
    .eq('workspace_id', workspaceId).eq('project_id', projectId).eq('file_id', fileId)
    .eq('requested_by', userId).eq('input_summary->>page_strategy','sheet-v1')
    .eq('input_summary->>file_sha256', sha256).order('created_at',{ascending:false}).limit(1001);
  if (response.error || !Array.isArray(response.data)) throw new ProjectApiError(503, 'Saved page reviews could not be loaded.');
  if (response.data.length >= 1000) throw new ProjectApiError(409, 'Page-review history requires reconciliation before resuming.');
  const byPage = new Map<number, any>();
  const trades = [...scope.trades].sort().join('|');
  for (const job of response.data) {
    const meta = job.input_summary;
    const page = meta?.physical_page_number;
    if (!Number.isInteger(page) || page < 1 || page > pages || meta.physical_page_count !== pages
      || meta.requested_scope !== scope.scope || !Array.isArray(meta.requested_trades)
      || [...meta.requested_trades].sort().join('|') !== trades || byPage.has(page)) continue;
    byPage.set(page, job);
  }
  return {
    strategy: 'sheet-v1', fileId, sourceSha256: sha256, totalPages: pages,
    scope: scope.scope, trades: scope.trades,
    completeTakeoffVerified: false,
    pages: Array.from({length: pages}, (_, index) => {
      const pageNumber = index + 1; const job = byPage.get(pageNumber);
      return { pageNumber, jobId: job?.id ?? null, status: job?.status ?? 'not_started',
        processingError: job?.processing_error ? 'Page review needs attention; its prior request will not be automatically replayed.' : null,
        findingCount: Number.isInteger(job?.output_summary?.finding_count) ? job.output_summary.finding_count : null };
    }),
  };
}
