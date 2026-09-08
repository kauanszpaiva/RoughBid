import { ProjectApiError, assertPlanStoragePath, type SupabaseLike } from '../projects/service.ts';
import { downloadPlan, inspectPdf, normalizeScope, PDF_DIGEST } from '../billing/project-preflight.ts';
import { isFreeOwnerWorkspace } from './owner-free.ts';
import { requireFreeProviderConfig } from './free-provider.ts';
import { requestFingerprint, type AiPlanObjectStorage, type PlanReader, type PlanReadingFindingsWriter } from './service.ts';
import type { PlanReadingResult } from './types.ts';

export type DurableEntitlement = 'paid' | 'owner_free';
export const AI_PLAN_QUEUES: Record<DurableEntitlement, string> = {
  paid: 'ai-plan-reading-paid',
  owner_free: 'ai-plan-reading-owner-free',
};
export const aiPlanQueueName = (entitlement: DurableEntitlement) => AI_PLAN_QUEUES[entitlement];

export interface DurableAiPlanQueue {
  isWorkerAvailable(entitlement: DurableEntitlement): Promise<boolean>;
  add(jobId: string, entitlement: DurableEntitlement): Promise<unknown>;
  close?(): Promise<void>;
}

export interface DurableQueueModule {
  Queue: new (name: string, options: unknown) => {
    add(name: string, data: unknown, options: unknown): Promise<unknown>;
    getWorkers(): Promise<Array<Record<string, string>>>;
    close(): Promise<void>;
  };
}

export async function createDurableAiPlanQueue(
  redisUrl: string,
  loader: () => Promise<DurableQueueModule> = () => import('bullmq') as Promise<unknown> as Promise<DurableQueueModule>,
): Promise<DurableAiPlanQueue> {
  if (!redisUrl) throw new Error('REDIS_URL is required for durable AI plan reading.');
  const bull = await loader();
  const connection = {
    url: redisUrl,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5_000,
    retryStrategy: () => null,
  };
  const queues = {
    paid: new bull.Queue(AI_PLAN_QUEUES.paid, { connection }),
    owner_free: new bull.Queue(AI_PLAN_QUEUES.owner_free, { connection }),
  };
  return {
    async isWorkerAvailable(entitlement) {
      try { return (await queues[entitlement].getWorkers()).length > 0; }
      catch { return false; }
    },
    add(jobId, entitlement) {
      return queues[entitlement].add('read-plan', { jobId }, {
        jobId,
        // Queue retries include crashes/lease races. Database RPCs separately
        // cap real provider calls (1 owner-free, 2 paid), so these retries
        // cannot silently spend an extra Gemini request.
        attempts: entitlement === 'owner_free' ? 2 : 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      });
    },
    async close() {
      await Promise.allSettled([queues.paid.close(), queues.owner_free.close()]);
    },
  };
}

function dbResult<T>(result: { data: T; error: { message?: string } | null }, notFound = false): T {
  if (result.error) throw new ProjectApiError(500, result.error.message ?? 'Database operation failed');
  if (notFound && !result.data) throw new ProjectApiError(404, 'Resource not found');
  return result.data;
}

function normalizedJob(job: any) {
  return { ...job, plan_reading_findings: Array.isArray(job?.plan_reading_findings) ? job.plan_reading_findings : [] };
}

export class DurableAiPlanReadingService {
  private readonly db: SupabaseLike;
  private readonly writer: PlanReadingFindingsWriter;
  private readonly storage: AiPlanObjectStorage;
  private readonly queue: DurableAiPlanQueue;
  private readonly userId: string;
  private readonly workspaceId: string;
  private readonly fetcher: typeof fetch;

  constructor(
    db: SupabaseLike,
    writer: PlanReadingFindingsWriter,
    storage: AiPlanObjectStorage,
    queue: DurableAiPlanQueue,
    userId: string,
    workspaceId: string,
    fetcher: typeof fetch = fetch,
  ) {
    this.db = db;
    this.writer = writer;
    this.storage = storage;
    this.queue = queue;
    this.userId = userId;
    this.workspaceId = workspaceId;
    this.fetcher = fetcher;
  }

  async reserve(projectId: string, input: Record<string, unknown>) {
    if (!this.writer.rpc) throw new ProjectApiError(503, 'Durable AI plan reservation is unavailable.');
    const fileId = typeof input.file_id === 'string' ? input.file_id : '';
    if (!fileId) throw new ProjectApiError(400, 'file_id is required');

    const workspace = dbResult<any>(
      await this.db.from('workspaces').select('ai_processing_consented_at').eq('id', this.workspaceId).maybeSingle(), true,
    );
    if (!workspace.ai_processing_consented_at) {
      throw new ProjectApiError(403, 'This workspace must accept AI plan-reading data processing before starting a job.');
    }
    dbResult(await this.db.from('projects').select('id').eq('workspace_id', this.workspaceId).eq('id', projectId).maybeSingle(), true);
    const file = dbResult<any>(
      await this.db.from('project_files').select('id, original_name, storage_path, processing_status, page_count')
        .eq('workspace_id', this.workspaceId).eq('project_id', projectId).eq('id', fileId).maybeSingle(), true,
    );
    if (file.processing_status === 'uploading' || file.processing_status === 'failed') {
      throw new ProjectApiError(409, 'Plan file must finish uploading before AI reading can start');
    }

    const freeOwner = isFreeOwnerWorkspace(this.workspaceId, process.env);
    const entitlement: DurableEntitlement = freeOwner ? 'owner_free' : 'paid';
    const heartbeat = await this.writer.rpc('ai_plan_worker_available', { p_entitlement: entitlement });
    if (heartbeat.error || heartbeat.data !== true || !(await this.queue.isWorkerAvailable(entitlement))) {
      throw new ProjectApiError(503, `A live durable worker with ${entitlement === 'paid' ? 'paid' : 'owner-free'} provider access is not available. No job was queued.`);
    }

    let reserved: any;
    if (freeOwner) {
      const config = requireFreeProviderConfig(process.env);
      const normalized = normalizeScope(input);
      assertPlanStoragePath(file.storage_path, this.workspaceId, projectId, fileId);
      const presigned = await this.storage.presign('GET', file.storage_path, { expiresIn: 300 });
      const bytes = await downloadPlan(presigned.url, this.fetcher);
      const inspected = await inspectPdf(bytes);
      const sha256 = PDF_DIGEST(bytes);
      const mode = typeof input.mode === 'string' ? input.mode : 'quick';
      const fingerprint = await requestFingerprint({
        trades: normalized.trades,
        scope: normalized.scope,
        model: config.model,
        mode,
        sha256,
      });
      reserved = await this.writer.rpc('reserve_owner_free_reading_async', {
        p_user_id: this.userId,
        p_workspace_id: this.workspaceId,
        p_project_id: projectId,
        p_file_id: fileId,
        p_model: config.model,
        p_file_sha256: sha256,
        p_request_fingerprint: fingerprint,
        p_requested_trades: normalized.trades,
        p_requested_scope: normalized.scope,
        p_mode: mode,
        p_page_count: inspected.pages,
      });
      if (reserved.error) throw new ProjectApiError(403, reserved.error.message ?? 'This workspace is not authorized for free plan reading.');
    } else {
      const quoteId = typeof input.quote_id === 'string' ? input.quote_id : '';
      if (!quoteId) throw new ProjectApiError(402, 'Review and pay the project processing price before starting AI.');
      reserved = await this.writer.rpc('reserve_project_reading_async', {
        p_quote_id: quoteId,
        p_user_id: this.userId,
        p_workspace_id: this.workspaceId,
        p_project_id: projectId,
        p_file_id: fileId,
        p_model: process.env.GEMINI_MODEL || 'gemini',
      });
      if (reserved.error) throw new ProjectApiError(402, reserved.error.message ?? 'A confirmed payment for this plan is required.');
    }

    const payload = reserved.data as { reused?: boolean; job?: any };
    if (!payload?.job?.id) throw new ProjectApiError(500, 'Durable AI plan reservation did not return a job.');
    if (payload.reused) return normalizedJob(await this.get(payload.job.id));

    try {
      await this.queue.add(payload.job.id, entitlement);
    } catch {
      let released = false;
      try {
        const rollback = await this.writer.rpc('rollback_ai_plan_enqueue', {
          p_job_id: payload.job.id,
          p_user_id: this.userId,
        });
        released = !rollback.error && rollback.data === true;
      } catch { /* Ambiguous acknowledgement: reconcile from durable state below. */ }

      if (released) {
        throw new ProjectApiError(503, 'AI plan queue is unavailable. The reservation was released before provider work began.');
      }

      try {
        // Redis may have accepted the deterministic job id even when the client
        // lost the acknowledgement. If rollback is refused because the worker
        // already advanced the job, the database is authoritative: return that
        // durable state instead of lying that no provider call occurred.
        return normalizedJob(await this.get(payload.job.id));
      } catch {
        throw new ProjectApiError(503, 'AI plan queue acknowledgement failed. The job may have started. Check its status before retrying.');
      }
    }
    return normalizedJob(payload.job);
  }

  async get(jobId: string) {
    const job = dbResult<any>(
      await this.db.from('plan_reading_jobs').select('*, plan_reading_findings(*)')
        .eq('workspace_id', this.workspaceId).eq('id', jobId).maybeSingle(), true,
    );
    if (job.output_summary?.synthetic) throw new ProjectApiError(409, 'This older reading contains simulated quantities. Request a new reading.');
    return normalizedJob(job);
  }

  async cancel(jobId: string) {
    if (!this.writer.rpc) throw new ProjectApiError(503, 'AI plan cancellation is unavailable.');
    const result = await this.writer.rpc('request_ai_plan_cancel', {
      p_job_id: jobId, p_user_id: this.userId, p_workspace_id: this.workspaceId,
    });
    if (result.error) throw new ProjectApiError(403, result.error.message ?? 'Could not cancel the AI plan reading.');
    return normalizedJob(result.data);
  }
}

export interface DurableAiPlanWorkerJob {
  data: { jobId: string };
  attemptsMade: number;
  opts: { attempts?: number };
}

export class DurableAiPlanJobProcessor {
  private readonly writer: PlanReadingFindingsWriter;
  private readonly storage: AiPlanObjectStorage;
  private readonly paidReader: PlanReader;
  private readonly freeReader: PlanReader | undefined;
  private readonly workerId: string;
  private readonly fetcher: typeof fetch;

  constructor(
    writer: PlanReadingFindingsWriter,
    storage: AiPlanObjectStorage,
    paidReader: PlanReader,
    freeReader: PlanReader | undefined,
    workerId: string,
    fetcher: typeof fetch = fetch,
  ) {
    this.writer = writer;
    this.storage = storage;
    this.paidReader = paidReader;
    this.freeReader = freeReader;
    this.workerId = workerId;
    this.fetcher = fetcher;
  }

  async process(queueJob: DurableAiPlanWorkerJob) {
    if (!this.writer.rpc) throw new Error('Durable AI plan RPC support is required.');
    const claimed = await this.writer.rpc('claim_ai_plan_reading', { p_job_id: queueJob.data.jobId, p_worker_id: this.workerId });
    if (claimed.error) throw new Error(claimed.error.message ?? 'Could not claim AI plan reading.');
    if (claimed.data?.skip) return claimed.data;

    const context = claimed.data as any;
    const leaseId = String(context.lease_id || '');
    if (!leaseId) throw new Error('AI plan claim did not return a lease.');
    let canceled = false;
    const heartbeat = async () => {
      const result = await this.writer.rpc!('heartbeat_ai_plan_reading', {
        p_job_id: queueJob.data.jobId, p_lease_id: leaseId, p_worker_id: this.workerId,
      });
      if (result.error || result.data !== true) canceled = true;
      return !canceled;
    };
    const timer = setInterval(() => { void heartbeat(); }, 5_000);

    try {
      const checkpoint = context.checkpoint?.provider_result as PlanReadingResult | undefined;
      let result: PlanReadingResult;
      if (checkpoint) {
        result = checkpoint;
      } else {
        const reader = context.entitlement === 'owner_free' ? this.freeReader : this.paidReader;
        if (!reader) throw new Error('The authorized provider is not configured on the durable worker.');
        reader.assertReady?.();
        assertPlanStoragePath(context.storage_path, context.workspace_id, context.project_id, context.file_id);
        const presigned = await this.storage.presign('GET', context.storage_path, { expiresIn: 300 });
        const bytes = await downloadPlan(presigned.url, this.fetcher);
        if (PDF_DIGEST(bytes) !== context.file_sha256) throw new Error('The plan changed after authorization.');
        const attempt = await this.writer.rpc('begin_ai_plan_provider_attempt', {
          p_job_id: queueJob.data.jobId, p_lease_id: leaseId,
        });
        if (attempt.error) throw new Error(attempt.error.message ?? 'Provider attempt was not authorized.');
        result = await reader.read({
          fileBytes: bytes,
          mimeType: 'application/pdf',
          sheetName: context.original_name,
          requestedTrades: context.requested_trades,
          scope: context.requested_scope,
        });
        if (result.summary.synthetic || !result.findings.length) throw new Error('No usable findings were returned. No substitute quantities were saved.');
        if (result.findings.some((f) => (f.quantity !== null || Object.keys(f.geometry).length > 0) && (!f.page_number || f.page_number > context.page_count))) {
          throw new Error('The reading contains quantities or locations without valid source pages.');
        }
        if (!(await heartbeat())) throw new Error('AI plan reading was canceled or its worker lease expired.');
        const checkpointed = await this.writer.rpc('checkpoint_ai_plan_reading', {
          p_job_id: queueJob.data.jobId,
          p_lease_id: leaseId,
          p_result: result,
        });
        if (checkpointed.error) throw new Error(checkpointed.error.message ?? 'Could not checkpoint provider output.');
      }

      if (!(await heartbeat())) throw new Error('AI plan reading was canceled or its worker lease expired.');
      const findings = result.findings.map((finding) => ({
        job_id: queueJob.data.jobId,
        workspace_id: context.workspace_id,
        project_id: context.project_id,
        file_id: context.file_id,
        page_number: finding.page_number,
        finding_type: finding.finding_type,
        label: finding.label,
        value_text: finding.value_text,
        quantity: finding.quantity,
        unit: finding.unit,
        confidence: finding.confidence,
        geometry: finding.geometry,
        source_excerpt: finding.source_excerpt,
      }));
      const finish = context.entitlement === 'owner_free'
        ? await this.writer.rpc('finish_owner_free_reading', {
            p_job_id: queueJob.data.jobId, p_user_id: context.requested_by,
            p_summary: result.summary, p_findings: findings, p_error: null,
          })
        : await this.writer.rpc('finish_project_reading', {
            p_quote_id: context.quote_id, p_job_id: queueJob.data.jobId,
            p_summary: result.summary, p_findings: findings, p_error: null,
          });
      if (finish.error) throw new Error(finish.error.message ?? 'Could not persist AI plan reading.');
      return finish.data;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1000) : 'AI plan reading failed';
      const maxAttempts = Number(queueJob.opts.attempts ?? 1);
      const finalAttempt = queueJob.attemptsMade + 1 >= maxAttempts;
      if (!finalAttempt && !canceled) {
        await this.writer.rpc('release_ai_plan_reading_retry', {
          p_job_id: queueJob.data.jobId, p_lease_id: leaseId, p_error: message,
        });
      } else if (context.entitlement === 'owner_free') {
        await this.writer.rpc('finish_owner_free_reading', {
          p_job_id: queueJob.data.jobId, p_user_id: context.requested_by,
          p_summary: {}, p_findings: [], p_error: message,
        });
      } else {
        await this.writer.rpc('finish_project_reading', {
          p_quote_id: context.quote_id, p_job_id: queueJob.data.jobId,
          p_summary: {}, p_findings: [], p_error: message,
        });
      }
      throw error;
    } finally {
      clearInterval(timer);
    }
  }
}