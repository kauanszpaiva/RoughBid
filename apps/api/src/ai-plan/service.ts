import { ProjectApiError, assertPlanStoragePath, type SupabaseLike } from '../projects/service.ts';
import { downloadPlan, inspectPdf, normalizeScope, PDF_DIGEST } from '../billing/project-preflight.ts';
import { isFreeOwnerWorkspace } from './owner-free.ts';
import { FREE_PROVIDER_UNCONFIGURED, requireFreeProviderConfig } from './free-provider.ts';
import type { GeminiPlanReadInput } from './gemini.ts';
import type { PlanReadingResult } from './types.ts';

export type PlanReadingStatus = 'queued' | 'processing' | 'needs_review' | 'ready' | 'failed';

/**
 * Stable identity of one analysis request. Two requests re-use the same job
 * only when the plan bytes AND everything that changes the analysis (trades,
 * scope, model, mode) are identical, so a re-run with a different scope is a
 * new analysis rather than a silent re-use of the previous result.
 */
export async function requestFingerprint(parts: {
  trades: string[]; scope: string; model: string; mode: string; sha256: string;
}): Promise<string> {
  const canonical = JSON.stringify({
    trades: [...parts.trades].sort(), scope: parts.scope.trim(),
    model: parts.model, mode: parts.mode, sha256: parts.sha256,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export type PlanReadingFindingStatus = 'needs_review' | 'accepted' | 'rejected';

export interface AiPlanObjectStorage {
  presign(method: 'GET', key: string, options?: { expiresIn?: number }): { url: string } | Promise<{ url: string }>;
}

/** GeminiPlanReader satisfies this structurally; kept narrow so tests can fake it without the real SDK. */
export interface PlanReader {
  assertReady?(): void;
  read(input: GeminiPlanReadInput): Promise<PlanReadingResult>;
}

/**
 * Minimal surface needed to insert findings with a service-role connection.
 * Authenticated users have no direct table privilege on plan_reading_findings
 * (see 0007's `revoke insert, update, delete ... from authenticated, anon`),
 * so this write can never go through the request's own RLS-scoped client —
 * it needs the same service-role connection the (now-retired) async worker
 * used, just invoked inline instead of from a separate process.
 */
export interface PlanReadingFindingsWriter {
  from(table: string): any;
  rpc?(fn: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: any }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Cheap guardrail against runaway AI spend; override per-deployment via env. */
const DEFAULT_DAILY_JOB_LIMIT = 25;
function dbResult<T>(result: { data: T; error: { message?: string } | null }, notFound = false): T {
  if (result.error) throw new ProjectApiError(500, result.error.message ?? 'Database operation failed');
  if (notFound && !result.data) throw new ProjectApiError(404, 'Resource not found');
  return result.data;
}

/**
 * Reads a paid plan synchronously, inline in the HTTP request — the
 * approach that actually shipped and worked (an earlier BullMQ-queued design
 * needed a separately-deployed worker process that never ran in production).
 * Gemini receives the uploaded PDF directly, so this never waits on the
 * Poppler page-rendering step either; it only needs the upload to have
 * finished.
 */
export class AiPlanReadingService {
  private readonly db: SupabaseLike;
  private readonly findingsWriter: PlanReadingFindingsWriter;
  private readonly storage: AiPlanObjectStorage;
  private readonly reader: PlanReader;
  private readonly freeReader: PlanReader | undefined;
  private readonly fetcher: typeof fetch;
  private readonly userId: string;
  private readonly workspaceId: string;

  constructor(
    db: SupabaseLike,
    findingsWriter: PlanReadingFindingsWriter,
    storage: AiPlanObjectStorage,
    reader: PlanReader,
    userId: string,
    workspaceId: string,
    fetcher: typeof fetch = fetch,
    freeReader?: PlanReader,
  ) {
    if (!userId || !workspaceId) throw new ProjectApiError(401, 'Authentication and workspace are required');
    this.db = db;
    this.findingsWriter = findingsWriter;
    this.storage = storage;
    this.reader = reader;
    this.userId = userId;
    this.workspaceId = workspaceId;
    this.fetcher = fetcher;
    this.freeReader = freeReader;
  }

  async create(projectId: string, input: Record<string, unknown>) {
    const fileId = typeof input.file_id === 'string' ? input.file_id : '';
    if (!fileId) throw new ProjectApiError(400, 'file_id is required');

    const workspaceRow = dbResult<any>(
      await this.db.from('workspaces').select('ai_processing_consented_at').eq('id', this.workspaceId).maybeSingle(),
      true,
    );
    if (!workspaceRow.ai_processing_consented_at) {
      throw new ProjectApiError(403, 'This workspace must accept AI plan-reading data processing (workspace settings) before starting a job.');
    }

    dbResult(await this.db.from('projects').select('id').eq('workspace_id', this.workspaceId).eq('id', projectId).maybeSingle(), true);
    const file = dbResult<any>(
      await this.db.from('project_files').select('id, original_name, storage_path, processing_status, page_count')
        .eq('workspace_id', this.workspaceId).eq('project_id', projectId).eq('id', fileId).maybeSingle(),
      true,
    );
    // Gemini reads the uploaded PDF directly, so this only needs the upload
    // itself to have finished — not the separate Poppler page-render step.
    if (file.processing_status === 'uploading' || file.processing_status === 'failed') {
      throw new ProjectApiError(409, 'Plan file must finish uploading before AI reading can start');
    }

    // This advisory pre-check only bounds NEW work. It deliberately does not run
    // on the free path, where the reservation RPC decides atomically under the
    // workspace lock: re-using an existing job consumes no provider request, so
    // being at the cap must not stop the owner reading back a job already
    // running. A genuinely new free attempt is still capped inside the RPC.
    const freeOwnerCandidate = isFreeOwnerWorkspace(this.workspaceId, process.env);
    if (!freeOwnerCandidate) {
      const dailyLimit = Number(process.env.AI_PLAN_DAILY_JOB_LIMIT) || DEFAULT_DAILY_JOB_LIMIT;
      const since = new Date(Date.now() - DAY_MS).toISOString();
      const recentJobs = dbResult<any[]>(
        await this.db.from('plan_reading_jobs').select('id').eq('workspace_id', this.workspaceId).gte('created_at', since),
      );
      if (recentJobs.length >= dailyLimit) {
        throw new ProjectApiError(429, `This workspace has started ${recentJobs.length} AI plan readings in the last 24 hours, at its limit of ${dailyLimit}.`);
      }
    }

    // The owner's own workspace may run a reading without payment, but only when
    // the entitlement AND a verified non-billed provider are both configured.
    // Every other workspace keeps the confirmed-payment requirement below.
    const freeOwner = freeOwnerCandidate;
    const quoteId = typeof input.quote_id === 'string' ? input.quote_id : '';
    if (!this.findingsWriter.rpc) throw new ProjectApiError(503, 'Project payment authorization is unavailable.');

    let job: any;
    let quote: any = null;
    let requestedTrades: string[];
    let scope: string;
    let freePlan: { bytes: Uint8Array; sha256: string; pages: number } | null = null;

    if (freeOwner) {
      // Hard failure before any provider call when the free project is not
      // configured and attested. Never falls back to the billed credential.
      const freeConfig = requireFreeProviderConfig(process.env);
      // Structural guarantee: the free path uses the free reader or nothing.
      // It never borrows `this.reader`, which is built from the billed project.
      if (!this.freeReader) throw new ProjectApiError(503, FREE_PROVIDER_UNCONFIGURED);
      this.freeReader.assertReady?.();
      const normalized = normalizeScope(input);
      requestedTrades = normalized.trades;
      scope = normalized.scope;
      // The free path has no quote to carry a server-verified digest, so the
      // file is fetched and inspected BEFORE reserving. The digest and the
      // normalized request identity form the re-use key, so a re-run with a
      // different scope, trade set or model is a distinct analysis rather than
      // a silent re-use of the previous one.
      freePlan = await this.loadPlanBytes(file, projectId, fileId);
      const fingerprint = await requestFingerprint({
        trades: requestedTrades, scope, model: freeConfig.model,
        mode: typeof input.mode === 'string' ? input.mode : 'quick',
        sha256: freePlan.sha256,
      });
      const reservedFree = await this.findingsWriter.rpc('reserve_owner_free_reading', {
        p_user_id: this.userId, p_workspace_id: this.workspaceId,
        p_project_id: projectId, p_file_id: fileId, p_model: freeConfig.model,
        p_file_sha256: freePlan.sha256, p_request_fingerprint: fingerprint,
      });
      if (reservedFree.error) {
        throw new ProjectApiError(403, reservedFree.error.message ?? 'This workspace is not authorized for free plan reading.');
      }
      if (reservedFree.data.reused) return this.get(reservedFree.data.job.id);
      job = reservedFree.data.job;
    } else {
      if (!quoteId) throw new ProjectApiError(402, 'Review and pay the project processing price before starting AI.');
      this.reader.assertReady?.();
      const reserved = await this.findingsWriter.rpc('reserve_project_reading', {
        p_quote_id: quoteId, p_user_id: this.userId, p_workspace_id: this.workspaceId,
        p_project_id: projectId, p_file_id: fileId, p_model: process.env.GEMINI_MODEL || 'gemini',
      });
      if (reserved.error) throw new ProjectApiError(402, 'A confirmed payment for this plan is required. Refresh the project payment status.');
      const { job: paidJob, quote: paidQuote, reused } = reserved.data;
      if (reused) return this.get(paidJob.id);
      job = paidJob;
      quote = paidQuote;

      // Server Guard: In production or test environments, a quote paid in test mode
      // (livemode === false) must NEVER invoke the paid production Gemini reader.
      // This stops TEST-paid quotes from triggering real Tier 1 Gemini API costs.
      const isTestPaidQuote = quote && quote.livemode === false;
      const isLiveModeEnv = process.env.STRIPE_MODE === 'live';
      if (isTestPaidQuote && (isLiveModeEnv || process.env.NODE_ENV === 'production')) {
        await this.findingsWriter.rpc('finish_project_reading', {
          p_quote_id: quoteId, p_job_id: job.id, p_summary: { test_mode: true }, p_findings: [],
          p_error: 'Test payment received. Paid production AI analysis is disabled for test-mode quotes.',
        });
        throw new ProjectApiError(402, 'Test payment received. Production AI plan reading is not performed for test-mode payments.');
      }

      requestedTrades = quote.trades as string[];
      scope = quote.scope as string;
    }

    try {
      // The free path already fetched and digested the plan to build its
      // re-use key; re-using those bytes avoids a second download and keeps the
      // analysed bytes identical to the ones the reservation was keyed on.
      let fileBytes: Uint8Array;
      if (freePlan) {
        fileBytes = freePlan.bytes;
      } else {
        assertPlanStoragePath(file.storage_path,this.workspaceId,projectId,fileId);
        const presigned = await this.storage.presign('GET', file.storage_path, { expiresIn: 300 });
        fileBytes = await downloadPlan(presigned.url, this.fetcher);
        if (PDF_DIGEST(fileBytes) !== quote.file_sha256) throw new ProjectApiError(409, 'The plan changed after payment. Contact support before processing.');
      }

      const activeReader = freeOwner ? this.freeReader! : this.reader;
      const result = await activeReader.read({
        fileBytes,
        mimeType: 'application/pdf',
        sheetName: file.original_name,
        requestedTrades,
        scope,
      });
      if (result.summary.synthetic || !result.findings.length) throw new Error('No usable findings were returned. No substitute quantities were saved.');
      // Page bound comes from the paid quote, or from the server's own
      // inspection of the bytes on the free path. Findings carrying a quantity
      // or geometry must cite a real page in this document either way.
      const pageCount = freePlan ? freePlan.pages : quote.page_count;
      if (result.findings.some(f => (f.quantity !== null || Object.keys(f.geometry).length > 0) && (!f.page_number || f.page_number > pageCount))) throw new Error('The reading contains quantities or locations without valid source pages.');
      const findingsRows = result.findings.map((finding) => {
        return {
          job_id: job.id,
          workspace_id: this.workspaceId,
          project_id: projectId,
          file_id: fileId,
          page_number: finding.page_number,
          finding_type: finding.finding_type,
          label: finding.label,
          value_text: finding.value_text,
          quantity: finding.quantity,
          unit: finding.unit,
          confidence: finding.confidence,
          geometry: finding.geometry,
          source_excerpt: finding.source_excerpt,
        };
      });

      const finished = freeOwner
        ? await this.findingsWriter.rpc('finish_owner_free_reading', {
            p_job_id: job.id, p_user_id: this.userId, p_error: null,
            p_findings: findingsRows, p_summary: result.summary,
          })
        : await this.findingsWriter.rpc('finish_project_reading', {
            p_quote_id: quoteId, p_job_id: job.id, p_error: null,
            p_findings: findingsRows, p_summary: result.summary,
          });
      if (finished.error) throw new Error('Could not save the reading. Check its status before retrying.');
      return finished.data;
    } catch (error) {
      const failure = error instanceof Error ? error.message.slice(0, 1000) : 'Plan reading failed';
      if (freeOwner) {
        await this.findingsWriter.rpc('finish_owner_free_reading', {
          p_job_id: job.id, p_user_id: this.userId, p_summary: {}, p_findings: [], p_error: failure,
        });
      } else {
        await this.findingsWriter.rpc('finish_project_reading', {
          p_quote_id: quoteId, p_job_id: job.id, p_summary: {}, p_findings: [], p_error: failure,
        });
      }
      if (error instanceof ProjectApiError) throw error;
      throw new ProjectApiError(502, error instanceof Error ? error.message : 'AI plan reading failed');
    }
  }

  /**
   * Fetches and inspects the stored plan. Used by the free path, which has no
   * paid quote to carry a server-verified digest or page count.
   */
  private async loadPlanBytes(file: any, projectId: string, fileId: string) {
    assertPlanStoragePath(file.storage_path, this.workspaceId, projectId, fileId);
    const presigned = await this.storage.presign('GET', file.storage_path, { expiresIn: 300 });
    const bytes = await downloadPlan(presigned.url, this.fetcher);
    const { pages } = await inspectPdf(bytes);
    return { bytes, sha256: PDF_DIGEST(bytes), pages };
  }

  async get(jobId: string) {
    const job = dbResult<any>(
      await this.db.from('plan_reading_jobs').select('*, plan_reading_findings(*)').eq('workspace_id', this.workspaceId).eq('id', jobId).maybeSingle(),
      true,
    );
    if (job.output_summary?.synthetic) throw new ProjectApiError(409, 'This older reading contains simulated quantities. Select your real plan and request a new reading.');
    return job;
  }

  /**
   * Lets an estimator accept or reject one finding. Goes through the
   * set_plan_reading_finding_status RPC (see supabase/migrations/0015_...)
   * because authenticated users have no direct table privilege on
   * plan_reading_findings — only this service's insert (above) can write.
   */
  async setFindingStatus(findingId: string, status: PlanReadingFindingStatus) {
    if (!this.db.rpc) throw new ProjectApiError(500, 'Supabase RPC support is required.');
    const { data, error } = await this.db.rpc('set_plan_reading_finding_status', { finding_id: findingId, new_status: status });
    if (error) throw new ProjectApiError(403, error.message ?? 'Could not update the finding.');
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || (row as { workspace_id?: string }).workspace_id !== this.workspaceId) {
      throw new ProjectApiError(404, 'Finding not found');
    }
    return row;
  }
}
