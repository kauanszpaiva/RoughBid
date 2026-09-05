import { ProjectApiError, type SupabaseLike } from '../projects/service.ts';
import { priceFindings } from './pricing.ts';
import type { GeminiPlanReadInput } from './gemini.ts';
import type { PlanReadingResult } from './types.ts';

export type PlanReadingStatus = 'queued' | 'processing' | 'needs_review' | 'ready' | 'failed';
export type PlanReadingFindingStatus = 'needs_review' | 'accepted' | 'rejected';

export interface AiPlanObjectStorage {
  presign(method: 'GET', key: string, options?: { expiresIn?: number }): { url: string } | Promise<{ url: string }>;
}

/** GeminiPlanReader satisfies this structurally; kept narrow so tests can fake it without the real SDK. */
export interface PlanReader {
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
  from(table: 'plan_reading_findings'): any;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Cheap guardrail against runaway AI spend; override per-deployment via env. */
const DEFAULT_DAILY_JOB_LIMIT = 25;
const DEFAULT_TRADES = ['Framing', 'Concrete', 'Drywall', 'Electrical', 'Plumbing', 'HVAC', 'Finishes'];

function optionalMode(value: unknown): 'quick' | 'detailed' {
  return value === 'detailed' ? 'detailed' : 'quick';
}

function dbResult<T>(result: { data: T; error: { message?: string } | null }, notFound = false): T {
  if (result.error) throw new ProjectApiError(500, result.error.message ?? 'Database operation failed');
  if (notFound && !result.data) throw new ProjectApiError(404, 'Resource not found');
  return result.data;
}

function average(values: readonly number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Reads and prices a plan synchronously, inline in the HTTP request — the
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
  ) {
    if (!userId || !workspaceId) throw new ProjectApiError(401, 'Authentication and workspace are required');
    this.db = db;
    this.findingsWriter = findingsWriter;
    this.storage = storage;
    this.reader = reader;
    this.userId = userId;
    this.workspaceId = workspaceId;
    this.fetcher = fetcher;
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
      await this.db.from('project_files').select('id, original_name, storage_path, processing_status')
        .eq('workspace_id', this.workspaceId).eq('project_id', projectId).eq('id', fileId).maybeSingle(),
      true,
    );
    // Gemini reads the uploaded PDF directly, so this only needs the upload
    // itself to have finished — not the separate Poppler page-render step.
    if (file.processing_status === 'uploading' || file.processing_status === 'failed') {
      throw new ProjectApiError(409, 'Plan file must finish uploading before AI reading can start');
    }

    const dailyLimit = Number(process.env.AI_PLAN_DAILY_JOB_LIMIT) || DEFAULT_DAILY_JOB_LIMIT;
    const since = new Date(Date.now() - DAY_MS).toISOString();
    const recentJobs = dbResult<any[]>(
      await this.db.from('plan_reading_jobs').select('id').eq('workspace_id', this.workspaceId).gte('created_at', since),
    );
    if (recentJobs.length >= dailyLimit) {
      throw new ProjectApiError(429, `This workspace has started ${recentJobs.length} AI plan readings in the last 24 hours, at its limit of ${dailyLimit}.`);
    }

    const requestedTrades = Array.isArray(input.trades)
      ? input.trades.filter((trade): trade is string => typeof trade === 'string')
      : DEFAULT_TRADES;
    const scope = typeof input.scope === 'string' ? input.scope.slice(0, 500) : null;

    const job = dbResult<any>(await this.db.from('plan_reading_jobs').insert({
      workspace_id: this.workspaceId,
      project_id: projectId,
      file_id: fileId,
      requested_by: this.userId,
      status: 'processing',
      mode: optionalMode(input.mode),
      model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
      started_at: new Date().toISOString(),
      input_summary: { requested_scope: scope, requested_trades: requestedTrades, human_review_required: true },
    }).select('*').single());

    try {
      const presigned = await this.storage.presign('GET', file.storage_path, { expiresIn: 300 });
      const response = await this.fetcher(presigned.url);
      if (!response.ok) throw new Error(`Could not download the uploaded plan (${response.status})`);
      const fileBytes = new Uint8Array(await response.arrayBuffer());

      const result = await this.reader.read({
        fileBytes,
        mimeType: 'application/pdf',
        sheetName: file.original_name,
        requestedTrades,
        scope,
      });
      const pricing = priceFindings(result.findings);

      const findingsRows = result.findings.map((finding, index) => {
        const priced = pricing.byFindingIndex.get(index);
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
          geometry: priced ? { ...finding.geometry, pricing: priced } : finding.geometry,
          source_excerpt: finding.source_excerpt,
        };
      });

      let insertedFindings: any[] = [];
      if (findingsRows.length) {
        const inserted = await this.findingsWriter.from('plan_reading_findings').insert(findingsRows).select('*');
        if (inserted.error) throw new Error(inserted.error.message ?? 'Could not store plan reading findings');
        insertedFindings = inserted.data ?? [];
      }

      const updatedJob = dbResult<any>(await this.db.from('plan_reading_jobs').update({
        status: 'needs_review',
        confidence: average(result.findings.map((finding) => finding.confidence)),
        output_summary: {
          ...result.summary,
          pricing: {
            materialCost: pricing.totals.categoryTotals.material,
            laborCost: pricing.totals.categoryTotals.labor,
            directCost: pricing.totals.directCost,
            pricedFindings: pricing.pricedFindings,
            unpricedFindings: pricing.unpricedFindings,
          },
        },
        completed_at: new Date().toISOString(),
      }).eq('id', job.id).eq('workspace_id', this.workspaceId).select('*').single());

      return { ...updatedJob, plan_reading_findings: insertedFindings };
    } catch (error) {
      await this.db.from('plan_reading_jobs').update({
        status: 'failed',
        processing_error: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown plan reading error',
        completed_at: new Date().toISOString(),
      }).eq('id', job.id).eq('workspace_id', this.workspaceId);
      if (error instanceof ProjectApiError) throw error;
      throw new ProjectApiError(502, error instanceof Error ? error.message : 'AI plan reading failed');
    }
  }

  async get(jobId: string) {
    const job = dbResult<any>(
      await this.db.from('plan_reading_jobs').select('*, plan_reading_findings(*)').eq('workspace_id', this.workspaceId).eq('id', jobId).maybeSingle(),
      true,
    );
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
