import { ProjectApiError, type SupabaseLike } from '../projects/service.ts';
import { normalizePlanReadingScope } from './openai.ts';

export type PlanReadingStatus = 'queued' | 'processing' | 'needs_review' | 'ready' | 'failed';

export interface AiPlanQueueJob {
  jobId: string;
  workspaceId: string;
  projectId: string;
  fileId: string;
}

export interface AiPlanQueue {
  add(name: 'read-plan', data: AiPlanQueueJob, options: { jobId: string; attempts: number; backoff: { type: 'exponential'; delay: number }; removeOnComplete: number }): Promise<unknown>;
}

export interface BullMqQueueModule {
  Queue: new (name: string, options: unknown) => AiPlanQueue;
}

export async function createAiPlanQueue(redisUrl: string, loader: () => Promise<BullMqQueueModule> = () => import('bullmq') as Promise<unknown> as Promise<BullMqQueueModule>) {
  if (!redisUrl) throw new Error('REDIS_URL is required');
  const bull = await loader();
  return new bull.Queue('ai-plan-reading', { connection: { url: redisUrl, maxRetriesPerRequest: null } });
}

function optionalMode(value: unknown): 'quick' | 'detailed' {
  return value === 'detailed' ? 'detailed' : 'quick';
}

function dbResult<T>(result: { data: T; error: { message?: string } | null }, notFound = false): T {
  if (result.error) throw new ProjectApiError(500, result.error.message ?? 'Database operation failed');
  if (notFound && !result.data) throw new ProjectApiError(404, 'Resource not found');
  return result.data;
}

export class AiPlanReadingService {
  private readonly db: SupabaseLike;
  private readonly queue: AiPlanQueue;
  private readonly userId: string;
  private readonly workspaceId: string;

  constructor(db: SupabaseLike, queue: AiPlanQueue, userId: string, workspaceId: string) {
    if (!userId || !workspaceId) throw new ProjectApiError(401, 'Authentication and workspace are required');
    this.db = db;
    this.queue = queue;
    this.userId = userId;
    this.workspaceId = workspaceId;
  }

  async create(projectId: string, input: Record<string, unknown>) {
    const fileId = typeof input.file_id === 'string' ? input.file_id : '';
    if (!fileId) throw new ProjectApiError(400, 'file_id is required');

    dbResult(await this.db.from('projects').select('id').eq('workspace_id', this.workspaceId).eq('id', projectId).maybeSingle(), true);
    const file = dbResult<any>(
      await this.db.from('project_files').select('id, processing_status').eq('workspace_id', this.workspaceId).eq('project_id', projectId).eq('id', fileId).maybeSingle(),
      true,
    );
    if (file.processing_status !== 'ready') throw new ProjectApiError(409, 'Plan file must finish PDF processing before AI reading can start');
    const scope = normalizePlanReadingScope(input);

    const job = dbResult<any>(await this.db.from('plan_reading_jobs').insert({
      workspace_id: this.workspaceId,
      project_id: projectId,
      file_id: fileId,
      requested_by: this.userId,
      status: 'queued',
      mode: optionalMode(input.mode),
      model: process.env.OPENAI_MODEL || 'gpt-4.1',
      input_summary: {
        requested_scope: scope.legacyScope,
        scope_mode: scope.mode,
        requested_areas: scope.requestedAreas,
        requested_trades: scope.trades,
        commercial_plan_page_limit: 60,
        human_review_required: true,
      },
    }).select('*').single());

    await this.queue.add('read-plan', { jobId: job.id, workspaceId: this.workspaceId, projectId, fileId }, {
      jobId: job.id,
      attempts: 2,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 1000,
    });
    return job;
  }

  async get(jobId: string) {
    const job = dbResult<any>(
      await this.db.from('plan_reading_jobs').select('*, plan_reading_findings(*)').eq('workspace_id', this.workspaceId).eq('id', jobId).maybeSingle(),
      true,
    );
    return job;
  }
}
