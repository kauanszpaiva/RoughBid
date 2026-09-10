import { withUsageMeter } from '../owner-usage/meter.ts';
import { ProjectApiError, assertPlanStoragePath, type SupabaseLike } from '../projects/service.ts';
import { downloadPlan, inspectPdf, normalizeScope, PDF_DIGEST } from '../billing/project-preflight.ts';
import { isFreeOwnerWorkspace } from './owner-free.ts';
import { FREE_PROVIDER_UNCONFIGURED, requireFreeProviderConfig } from './free-provider.ts';
import type { GeminiPlanReadInput } from './gemini.ts';
import type { PlanReadingResult } from './types.ts';
import { PILOT_MODEL, PILOT_MAX_PAGES, PILOT_MAX_PDF_BYTES } from './pilot-reader.ts';
import { persistPlanPricingContext } from '../pricing/context.ts';
import { ProviderSpendLimitError, UsageAccountingError } from '../owner-usage/meter.ts';

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
  private readonly platformAdmin: boolean;
  private readonly pilotReader: PlanReader | undefined;

  constructor(
    db: SupabaseLike,
    findingsWriter: PlanReadingFindingsWriter,
    storage: AiPlanObjectStorage,
    reader: PlanReader,
    userId: string,
    workspaceId: string,
    fetcher: typeof fetch = fetch,
    freeReader?: PlanReader,
    platformAdmin = false,
    pilotReader?: PlanReader,
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
    this.platformAdmin = platformAdmin;
    this.pilotReader = pilotReader;
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

    const project = dbResult<any>(
      await this.db.from('projects').select('id, address_text').eq('workspace_id', this.workspaceId).eq('id', projectId).maybeSingle(),
      true,
    );
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

    // Platform-admin status is verified once at the trusted HTTP boundary and
    // injected into this service. It is a commercial bypass only: the scoped
    // workspace/project reads above still enforce tenancy, and the reservation
    // RPC repeats role/tenancy checks before provider work.
    const platformAdmin = this.platformAdmin;

    // Commercial quotas do not apply to the verified platform owner. Pilot work
    // has its own atomic project and cost reservation in the database.
    const freeOwnerCandidate = !platformAdmin && isFreeOwnerWorkspace(this.workspaceId, process.env);
    if (!platformAdmin && !freeOwnerCandidate && !this.pilotReader) {
      const dailyLimit = Number(process.env.AI_PLAN_DAILY_JOB_LIMIT) || DEFAULT_DAILY_JOB_LIMIT;
      const since = new Date(Date.now() - DAY_MS).toISOString();
      const recentJobs = dbResult<any[]>(
        await this.db.from('plan_reading_jobs').select('id').eq('workspace_id', this.workspaceId).gte('created_at', since),
      );
      if (recentJobs.length >= dailyLimit) {
        throw new ProjectApiError(429, `This workspace has started ${recentJobs.length} AI plan readings in the last 24 hours, at its limit of ${dailyLimit}.`);
      }
    }

    const quoteId = typeof input.quote_id === 'string' ? input.quote_id : '';
    if (!this.findingsWriter.rpc) throw new ProjectApiError(503, 'Project payment authorization is unavailable.');

    let job: any;
    let quote: any = null;
    let requestedTrades: string[];
    let scope: string;
    let unquotedPlan: { bytes: Uint8Array; sha256: string; pages: number } | null = null;
    let accessMode: 'platform_admin' | 'owner_free' | 'paid' | 'pilot';

    if (platformAdmin) {
      // Platform owner/tester uses the real paid provider but never manufactures
      // a Stripe payment or zero-dollar quote. The dedicated database RPC is the
      // server-side authorization boundary for this complimentary path.
      this.reader.assertReady?.();
      const normalized = normalizeScope(input);
      requestedTrades = normalized.trades;
      scope = normalized.scope;
      const model = process.env.GEMINI_MODEL || 'gemini';
      unquotedPlan = await this.loadPlanBytes(file, projectId, fileId);
      const fingerprint = await requestFingerprint({
        trades: requestedTrades,
        scope,
        model,
        mode: typeof input.mode === 'string' ? input.mode : 'quick',
        sha256: unquotedPlan.sha256,
      });
      const reserved = await this.findingsWriter.rpc('reserve_platform_admin_reading', {
        p_user_id: this.userId,
        p_workspace_id: this.workspaceId,
        p_project_id: projectId,
        p_file_id: fileId,
        p_model: model,
        p_file_sha256: unquotedPlan.sha256,
        p_request_fingerprint: fingerprint,
        p_requested_trades: requestedTrades,
        p_scope: scope,
      });
      if (reserved.error) {
        const message = reserved.error.message ?? 'Platform owner complimentary reading is not authorized.';
        throw new ProjectApiError(/daily AI reading limit/i.test(message) ? 429 : 403, message);
      }
      if (reserved.data.reused) return this.get(reserved.data.job.id);
      job = reserved.data.job;
      accessMode = 'platform_admin';
    } else if (this.pilotReader) {
      this.pilotReader.assertReady?.();
      const normalized = normalizeScope(input);
      requestedTrades = normalized.trades;
      scope = normalized.scope;
      unquotedPlan = await this.loadPlanBytes(file, projectId, fileId);
      if (unquotedPlan.bytes.length > PILOT_MAX_PDF_BYTES || unquotedPlan.pages > PILOT_MAX_PAGES) {
        throw new ProjectApiError(413, 'Pilot projects include one PDF of at most 10 MB and 10 pages.');
      }
      const fingerprint = await requestFingerprint({ trades: requestedTrades, scope, model: PILOT_MODEL, mode: 'pilot', sha256: unquotedPlan.sha256 });
      const reserved = await this.findingsWriter.rpc('reserve_pilot_reading', {
        p_user_id: this.userId, p_workspace_id: this.workspaceId, p_project_id: projectId, p_file_id: fileId,
        p_model: PILOT_MODEL, p_file_sha256: unquotedPlan.sha256, p_request_fingerprint: fingerprint,
        p_requested_trades: requestedTrades, p_scope: scope, p_page_count: unquotedPlan.pages, p_byte_size: unquotedPlan.bytes.length,
      });
      if (reserved.error) throw new ProjectApiError(429, reserved.error.message ?? 'Pilot limit reached.');
      if (reserved.data.reused) return this.get(reserved.data.job.id);
      job = reserved.data.job;
      accessMode = 'pilot';
    } else if (freeOwnerCandidate) {
      // Hard failure before any provider call when the isolated free project is
      // not configured and attested. Never falls back to the billed credential.
      const freeConfig = requireFreeProviderConfig(process.env);
      if (!this.freeReader) throw new ProjectApiError(503, FREE_PROVIDER_UNCONFIGURED);
      this.freeReader.assertReady?.();
      const normalized = normalizeScope(input);
      requestedTrades = normalized.trades;
      scope = normalized.scope;
      unquotedPlan = await this.loadPlanBytes(file, projectId, fileId);
      const fingerprint = await requestFingerprint({
        trades: requestedTrades, scope, model: freeConfig.model,
        mode: typeof input.mode === 'string' ? input.mode : 'quick',
        sha256: unquotedPlan.sha256,
      });
      const reservedFree = await this.findingsWriter.rpc('reserve_owner_free_reading', {
        p_user_id: this.userId, p_workspace_id: this.workspaceId,
        p_project_id: projectId, p_file_id: fileId, p_model: freeConfig.model,
        p_file_sha256: unquotedPlan.sha256, p_request_fingerprint: fingerprint,
      });
      if (reservedFree.error) {
        throw new ProjectApiError(403, reservedFree.error.message ?? 'This workspace is not authorized for free plan reading.');
      }
      if (reservedFree.data.reused) return this.get(reservedFree.data.job.id);
      job = reservedFree.data.job;
      accessMode = 'owner_free';
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
      requestedTrades = quote.trades as string[];
      scope = quote.scope as string;
      accessMode = 'paid';
    }

    try {
      // Complimentary paths pre-fetch and digest the plan to create their
      // idempotency key. Reusing those bytes guarantees the provider receives
      // exactly the bytes that were authorized by the reservation.
      let fileBytes: Uint8Array;
      if (unquotedPlan) {
        fileBytes = unquotedPlan.bytes;
      } else {
        assertPlanStoragePath(file.storage_path,this.workspaceId,projectId,fileId);
        const presigned = await this.storage.presign('GET', file.storage_path, { expiresIn: 300 });
        fileBytes = await downloadPlan(presigned.url, this.fetcher);
        if (PDF_DIGEST(fileBytes) !== quote.file_sha256) throw new ProjectApiError(409, 'The plan changed after payment. Contact support before processing.');
      }

      const activeReader = accessMode === 'pilot' ? this.pilotReader! : accessMode === 'owner_free' ? this.freeReader! : this.reader;
      const result = await withUsageMeter({ writer: this.findingsWriter, userId: this.userId,
        workspaceId: this.workspaceId, projectId, jobId: job.id,
        billing: accessMode === 'owner_free' ? 'verified_free' : 'paid',
      }, () => activeReader.read({
        fileBytes,
        mimeType: 'application/pdf',
        sheetName: file.original_name,
        requestedTrades,
        scope,
      }));
      if (result.summary.synthetic || !result.findings.length) throw new Error('No usable findings were returned. No substitute quantities were saved.');
      const pageCount = unquotedPlan ? unquotedPlan.pages : quote.page_count;
      if (result.findings.some(f => (f.quantity !== null || Object.keys(f.geometry).length > 0) && (!f.page_number || f.page_number > pageCount))) throw new Error('The reading contains quantities or locations without valid source pages.');

      await persistPlanPricingContext({
        writer: this.findingsWriter,
        workspaceId: this.workspaceId,
        projectId,
        projectAddressText: typeof project.address_text === 'string' ? project.address_text : null,
        planAddress: result.summary.project_address ?? null,
        fileId,
        jobId: job.id,
      });

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

      const finished = accessMode === 'pilot'
        ? await this.findingsWriter.rpc('finish_pilot_reading', {
            p_job_id: job.id, p_user_id: this.userId, p_error: null, p_findings: findingsRows, p_summary: result.summary,
          })
        : accessMode === 'platform_admin'
        ? await this.findingsWriter.rpc('finish_platform_admin_reading', {
            p_job_id: job.id, p_user_id: this.userId, p_error: null,
            p_findings: findingsRows, p_summary: result.summary,
          })
        : accessMode === 'owner_free'
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
      if (accessMode === 'pilot') {
        await this.findingsWriter.rpc('finish_pilot_reading', {
          p_job_id: job.id, p_user_id: this.userId, p_summary: {}, p_findings: [], p_error: failure,
        });
      } else if (accessMode === 'platform_admin') {
        await this.findingsWriter.rpc('finish_platform_admin_reading', {
          p_job_id: job.id, p_user_id: this.userId, p_summary: {}, p_findings: [], p_error: failure,
        });
      } else if (accessMode === 'owner_free') {
        await this.findingsWriter.rpc('finish_owner_free_reading', {
          p_job_id: job.id, p_user_id: this.userId, p_summary: {}, p_findings: [], p_error: failure,
        });
      } else {
        await this.findingsWriter.rpc('finish_project_reading', {
          p_quote_id: quoteId, p_job_id: job.id, p_summary: {}, p_findings: [], p_error: failure,
        });
      }
      if (error instanceof ProjectApiError) throw error;
      if (error instanceof ProviderSpendLimitError) throw new ProjectApiError(429, error.message);
      if (error instanceof UsageAccountingError) throw new ProjectApiError(503, error.message);
      throw new ProjectApiError(502, error instanceof Error ? error.message : 'AI plan reading failed');
    }
  }

  /** Fetches and inspects the stored plan for non-quote complimentary paths. */
  private async loadPlanBytes(file: any, projectId: string, fileId: string) {
    assertPlanStoragePath(file.storage_path, this.workspaceId, projectId, fileId);
    const presigned = await this.storage.presign('GET', file.storage_path, { expiresIn: 300 });
    const bytes = await downloadPlan(presigned.url, this.fetcher);
    const { pages } = await inspectPdf(bytes);
    return { bytes, sha256: PDF_DIGEST(bytes), pages };
  }

  async get(jobId: string) {
    // Both legacy job_id and composite tenant FKs exist. Choose the composite
    // relationship explicitly so PostgREST does not reject reload with PGRST201.
    const job = dbResult<any>(
      await this.db.from('plan_reading_jobs').select('*, plan_reading_findings!plan_reading_findings_job_workspace_project_file_fkey(*)').eq('workspace_id', this.workspaceId).eq('id', jobId).maybeSingle(),
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
