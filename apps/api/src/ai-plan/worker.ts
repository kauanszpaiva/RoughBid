import type { PlanPageInput, PlanReadingFinding, PlanReadingResult } from './openai.ts';
import { priceFindings } from './pricing.ts';
import type { AiPlanQueueJob } from './service.ts';

export interface PlanReader {
  read(pages: PlanPageInput[], scope?: string | null): Promise<PlanReadingResult>;
}

export interface WorkerObjectStorage {
  presign(method: 'GET', key: string, options?: { expiresIn?: number }): { url: string } | Promise<{ url: string }>;
}

export interface AiPlanWorkerDb {
  from(table: 'plan_reading_jobs' | 'plan_reading_findings' | 'project_file_pages'): any;
}

function average(values: readonly number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Consumes `read-plan` jobs queued by AiPlanReadingService.create(). Loads the
 * rendered plan pages, asks the model to read them, prices the resulting
 * material and labor findings, and persists both as reviewable rows — never
 * as trusted estimate data (see docs/architecture/ai-plan-reading-pipeline.md).
 */
export class AiPlanReadingJobProcessor {
  private readonly db: AiPlanWorkerDb;
  private readonly storage: WorkerObjectStorage;
  private readonly reader: PlanReader;

  constructor(db: AiPlanWorkerDb, storage: WorkerObjectStorage, reader: PlanReader) {
    this.db = db;
    this.storage = storage;
    this.reader = reader;
  }

  async process(job: AiPlanQueueJob) {
    const jobRow = await this.loadJob(job);
    await this.setJobState(job, { status: 'processing', started_at: new Date().toISOString(), processing_error: null });
    try {
      const pages = await this.loadPages(job);
      const scope = typeof jobRow.input_summary?.requested_scope === 'string' ? jobRow.input_summary.requested_scope : null;
      const result = await this.reader.read(pages, scope);
      const pricing = priceFindings(result.findings);

      const findingsRows = result.findings.map((finding: PlanReadingFinding, index: number) => {
        const priced = pricing.byFindingIndex.get(index);
        return {
          job_id: job.jobId,
          workspace_id: job.workspaceId,
          project_id: job.projectId,
          file_id: job.fileId,
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

      if (findingsRows.length) {
        const inserted = await this.db.from('plan_reading_findings').insert(findingsRows);
        if (inserted.error) throw new Error(inserted.error.message ?? 'Could not store plan reading findings');
      }

      await this.setJobState(job, {
        // Every finding still starts out needs_review — pricing narrows the
        // estimator's work, it never promotes a job straight to ready.
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
      });
      return { findings: findingsRows.length, pricing: pricing.totals };
    } catch (error) {
      await this.setJobState(job, {
        status: 'failed',
        processing_error: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown plan reading error',
        completed_at: new Date().toISOString(),
      });
      throw error;
    }
  }

  private async loadJob(job: AiPlanQueueJob): Promise<any> {
    const result = await this.db.from('plan_reading_jobs').select('*')
      .eq('id', job.jobId).eq('workspace_id', job.workspaceId).eq('project_id', job.projectId).eq('file_id', job.fileId)
      .maybeSingle();
    if (result.error || !result.data) throw new Error('Plan reading job was not found');
    return result.data;
  }

  private async loadPages(job: AiPlanQueueJob): Promise<PlanPageInput[]> {
    const result = await this.db.from('project_file_pages').select('page_number, storage_path')
      .eq('file_id', job.fileId).order('page_number', { ascending: true });
    if (result.error) throw new Error(result.error.message ?? 'Could not load rendered plan pages');
    const rows: Array<{ page_number: number; storage_path: string }> = result.data ?? [];
    if (!rows.length) throw new Error('Plan file has no rendered pages to read');
    const pages: PlanPageInput[] = [];
    for (const row of rows) {
      const presigned = await this.storage.presign('GET', row.storage_path, { expiresIn: 300 });
      pages.push({ pageNumber: row.page_number, imageUrl: presigned.url });
    }
    return pages;
  }

  private async setJobState(job: AiPlanQueueJob, changes: Record<string, unknown>): Promise<void> {
    const result = await this.db.from('plan_reading_jobs').update(changes)
      .eq('id', job.jobId).eq('workspace_id', job.workspaceId);
    if (result.error) throw new Error(result.error.message ?? 'Could not update plan reading job');
  }
}

export interface AiPlanBullMqModule {
  Worker: new (name: string, processor: (job: { data: AiPlanQueueJob }) => Promise<unknown>, options: unknown) => unknown;
}

/** Starts the BullMQ worker that drains the `ai-plan-reading` queue. */
export async function createAiPlanWorker(
  redisUrl: string,
  processor: AiPlanReadingJobProcessor,
  loader: () => Promise<AiPlanBullMqModule> = () => import('bullmq') as Promise<unknown> as Promise<AiPlanBullMqModule>,
) {
  if (!redisUrl) throw new Error('REDIS_URL is required');
  const bull = await loader();
  const connection = { url: redisUrl, maxRetriesPerRequest: null };
  return new bull.Worker('ai-plan-reading', (job) => processor.process(job.data), { connection, concurrency: 2 });
}
