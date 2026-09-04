import { ProjectApiError, type SupabaseLike } from '../projects/service.ts';
import type { PresignedObjectRequest } from '../storage/object-storage.ts';
import { OpenAiPlanReader, type PlanPageInput, type PlanReadingResult } from './openai.ts';

export interface AiPlanStorage {
  presign(method: 'GET' | 'PUT' | 'HEAD', key: string, options?: { expiresIn?: number; contentType?: string; downloadName?: string }): PresignedObjectRequest | Promise<PresignedObjectRequest>;
}

export interface AiPlanReader {
  read(pages: PlanPageInput[], scopeInput: unknown): Promise<PlanReadingResult>;
}

function dbResult<T>(result: { data: T; error: { message?: string } | null }, notFound = false): T {
  if (result.error) throw new ProjectApiError(500, result.error.message ?? 'Database operation failed');
  if (notFound && !result.data) throw new ProjectApiError(404, 'Resource not found');
  return result.data;
}

export class AiPlanReadingProcessor {
  private readonly db: SupabaseLike;
  private readonly storage: AiPlanStorage;
  private readonly reader: AiPlanReader;
  private readonly workspaceId: string;

  constructor(db: SupabaseLike, storage: AiPlanStorage, reader: AiPlanReader, workspaceId: string) {
    this.db = db;
    this.storage = storage;
    this.reader = reader;
    this.workspaceId = workspaceId;
  }

  async process(jobId: string) {
    const job = dbResult<any>(
      await this.db.from('plan_reading_jobs').select('*').eq('workspace_id', this.workspaceId).eq('id', jobId).maybeSingle(),
      true,
    );

    await this.updateJob(jobId, { status: 'processing', processing_error: null, started_at: new Date().toISOString() });
    try {
      const pages = dbResult<any[]>(
        await this.db.from('project_file_pages').select('page_number, storage_path').eq('file_id', job.file_id).order('page_number', { ascending: true }),
      );
      if (!pages.length) throw new ProjectApiError(409, 'Plan file has no rendered pages ready for AI reading');

      const signedPages: PlanPageInput[] = await Promise.all(pages.map(async (page) => {
        const signed = await this.storage.presign('GET', page.storage_path, { expiresIn: 900 });
        return { pageNumber: page.page_number, imageUrl: signed.url };
      }));

      const result = await this.reader.read(signedPages, job.input_summary ?? null);
      const findings = result.findings.map((finding) => ({
        workspace_id: job.workspace_id,
        project_id: job.project_id,
        file_id: job.file_id,
        job_id: job.id,
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

      if (findings.length) {
        const inserted = await this.db.from('plan_reading_findings').insert(findings);
        if (inserted.error) throw new ProjectApiError(500, inserted.error.message ?? 'Could not store AI plan findings');
      }

      const status = result.summary.coverage.completeness_status === 'blocked' ? 'failed' : 'needs_review';
      await this.updateJob(jobId, {
        status,
        output_summary: result.summary,
        completed_at: new Date().toISOString(),
      });
      return { id: job.id, status, summary: result.summary, findingsStored: findings.length };
    } catch (error) {
      await this.updateJob(jobId, {
        status: 'failed',
        processing_error: error instanceof Error ? error.message.slice(0, 1000) : 'AI plan reading failed',
        completed_at: new Date().toISOString(),
      });
      throw error;
    }
  }

  private async updateJob(jobId: string, changes: Record<string, unknown>) {
    const updated = await this.db.from('plan_reading_jobs').update(changes).eq('workspace_id', this.workspaceId).eq('id', jobId);
    if (updated.error) throw new ProjectApiError(500, updated.error.message ?? 'Could not update AI plan reading job');
  }
}

export function createOpenAiPlanReadingProcessor(db: SupabaseLike, storage: AiPlanStorage, workspaceId: string) {
  const reader = new OpenAiPlanReader(process.env.OPENAI_API_KEY ?? '', process.env.OPENAI_MODEL || 'gpt-4.1');
  return new AiPlanReadingProcessor(db, storage, reader, workspaceId);
}
