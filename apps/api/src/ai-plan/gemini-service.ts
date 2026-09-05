import { ProjectApiError, type SupabaseLike } from '../projects/service.ts';
import type { AiPlanStorage } from './processor.ts';
import { fetchPrivatePdf, GEMINI_MODEL, GeminiPdfReader } from './gemini.ts';
import { OPENROUTER_FREE_MODEL } from './openrouter.ts';
import { normalizePlanReadingScope } from './openai.ts';

type PlanReader = Pick<GeminiPdfReader, 'readPdf'> & { readonly configured?: boolean };
type PlanProvider = 'gemini' | 'openrouter';
const models = { gemini: GEMINI_MODEL, openrouter: OPENROUTER_FREE_MODEL };

function result<T>(r: { data: T; error: any }, missing = false): T {
  if (r.error) throw new ProjectApiError(500, 'Could not save the plan reading.');
  if (missing && !r.data) throw new ProjectApiError(404, 'Resource not found.');
  return r.data;
}

export async function requireEditor(db: SupabaseLike, workspaceId: string, userId: string) {
  const member = result<any>(await db.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle());
  if (!member || !['admin', 'estimator'].includes(member.role)) throw new ProjectApiError(403, 'An admin or estimator role is required.');
}

export class GeminiPlanService {
  private db: SupabaseLike;
  private writer: SupabaseLike;
  private storage: AiPlanStorage;
  private readers: Partial<Record<PlanProvider, PlanReader>>;
  private workspaceId: string;
  private userId: string;
  constructor(db: SupabaseLike, writer: SupabaseLike, storage: AiPlanStorage, reader: PlanReader, workspaceId: string, userId: string, alternatives: Partial<Record<PlanProvider, PlanReader>> = {}) {
    this.db = db; this.writer = writer; this.storage = storage; this.readers = { gemini: reader, ...alternatives }; this.workspaceId = workspaceId; this.userId = userId;
  }

  async get(id: string) {
    const job = result<any>(await this.db.from('plan_reading_jobs').select('*, plan_reading_findings!plan_reading_findings_job_id_fkey(*)').eq('workspace_id', this.workspaceId).eq('id', id).maybeSingle(), true);
    // Prove project visibility with the caller's RLS client before privileged writes.
    result(await this.db.from('projects').select('id').eq('workspace_id', this.workspaceId).eq('id', job.project_id).maybeSingle(), true);
    return job;
  }

  async create(projectId: string, input: Record<string, unknown>) {
    await requireEditor(this.db, this.workspaceId, this.userId);
    if (typeof input.file_id !== 'string') throw new ProjectApiError(400, 'file_id is required.');
    result(await this.db.from('projects').select('id').eq('workspace_id', this.workspaceId).eq('id', projectId).maybeSingle(), true);
    const file = result<any>(await this.db.from('project_files').select('*').eq('workspace_id', this.workspaceId).eq('project_id', projectId).eq('id', input.file_id).maybeSingle(), true);
    if (file.processing_status !== 'ready') throw new ProjectApiError(409, 'Complete the PDF upload before starting AI reading.');
    const provider = input.provider ?? 'gemini';
    if (provider !== 'gemini' && provider !== 'openrouter') throw new ProjectApiError(400, 'Choose Gemini or OpenRouter Free.');
    const reader = this.readers[provider];
    if (!reader || reader.configured === false) throw new ProjectApiError(503, `${provider === 'openrouter' ? 'OpenRouter Free' : 'Gemini'} needs its server API key before reading. No other provider was called.`);
    const model = models[provider];
    const scope = normalizePlanReadingScope(input);
    if (scope.mode === 'selected_scope' && !scope.requestedAreas.length) throw new ProjectApiError(400, 'Select at least one area, room, sheet, or zone.');
    // Reuse the existing reading for this file/scope; repeat clicks do not spend quota.
    const existing = result<any[]>(await this.db.from('plan_reading_jobs').select('*').eq('workspace_id', this.workspaceId).eq('file_id', file.id).eq('model', model).order('created_at', { ascending: false }).limit(20));
    const matching = existing.find(j => j.status !== 'failed' && JSON.stringify(normalizePlanReadingScope(j.input_summary)) === JSON.stringify(scope));
    if (matching) return matching;
    const recent = await this.db.from('plan_reading_jobs').select('id', { count: 'exact', head: true }).eq('workspace_id', this.workspaceId).gte('created_at', new Date(Date.now() - 86400_000).toISOString());
    if (recent.error) throw new ProjectApiError(503, 'Could not verify the daily AI limit.');
    if ((recent.count ?? 0) >= 20) throw new ProjectApiError(429, 'This workspace has reached its daily limit of 20 AI readings.');
    return result<any>(await this.db.from('plan_reading_jobs').insert({
      workspace_id: this.workspaceId, project_id: projectId, file_id: file.id, requested_by: this.userId,
      status: 'queued', mode: input.mode === 'detailed' ? 'detailed' : 'quick', model,
      input_summary: { scope_mode: scope.mode, requested_areas: scope.requestedAreas, requested_trades: scope.trades, requested_scope: scope.legacyScope, provider, human_review_required: true },
    }).select('*').single());
  }

  async process(id: string) {
    await requireEditor(this.db, this.workspaceId, this.userId);
    const job = await this.get(id);
    if (['needs_review', 'ready'].includes(job.status)) return { id, status: job.status, findingsStored: job.plan_reading_findings.length };
    if (job.status === 'processing') throw new ProjectApiError(409, 'This reading is already processing. Refresh results shortly.');
    const provider: PlanProvider = job.input_summary?.provider === 'openrouter' ? 'openrouter' : 'gemini';
    if (job.status !== 'queued' || job.model !== models[provider]) throw new ProjectApiError(409, 'Start a new reading with the selected provider.');
    const reader = this.readers[provider];
    if (!reader || reader.configured === false) throw new ProjectApiError(503, 'The selected AI provider needs its server API key. No fallback was called.');
    const file = result<any>(await this.db.from('project_files').select('*').eq('workspace_id', this.workspaceId).eq('project_id', job.project_id).eq('id', job.file_id).maybeSingle(), true);
    if (file.processing_status !== 'ready') throw new ProjectApiError(409, 'The PDF is not ready.');
    const claimed = result<any>(await this.writer.from('plan_reading_jobs').update({ status: 'processing', processing_error: null, started_at: new Date().toISOString() }).eq('workspace_id', this.workspaceId).eq('id', id).eq('status', 'queued').select('id').maybeSingle());
    if (!claimed) throw new ProjectApiError(409, 'This reading is already processing.');
    try {
      const signed = await this.storage.presign('GET', file.storage_path, { expiresIn: 180 });
      const bytes = await fetchPrivatePdf(signed.url, signed.headers);
      const output = await reader.readPdf(bytes, job.input_summary);
      if (output.findings.length) result(await this.writer.from('plan_reading_findings').insert(output.findings.map(f => ({
        ...f, job_id: id, workspace_id: this.workspaceId, project_id: job.project_id, file_id: job.file_id, status: 'needs_review',
      }))));
      const status = output.summary.coverage.completeness_status === 'blocked' ? 'failed' : 'needs_review';
      result(await this.writer.from('plan_reading_jobs').update({ status, output_summary: output.summary, completed_at: new Date().toISOString() }).eq('workspace_id', this.workspaceId).eq('id', id));
      return { id, status, findingsStored: output.findings.length };
    } catch (error) {
      await this.writer.from('plan_reading_jobs').update({ status: 'failed', processing_error: error instanceof ProjectApiError ? error.message : 'AI processing failed. Please retry.', completed_at: new Date().toISOString() }).eq('workspace_id', this.workspaceId).eq('id', id);
      throw error;
    }
  }

  async review(id: string, input: Record<string, unknown>) {
    await requireEditor(this.db, this.workspaceId, this.userId);
    const job = await this.get(id);
    if (job.status !== 'needs_review' && job.status !== 'ready') throw new ProjectApiError(409, 'This reading is not ready for review.');
    if (!['accepted', 'rejected'].includes(String(input.status))) throw new ProjectApiError(400, 'Choose accepted or rejected.');
    const finding = job.plan_reading_findings.find((f: any) => f.id === input.finding_id);
    if (!finding) throw new ProjectApiError(404, 'Finding not found.');
    if (finding.status !== 'needs_review' && finding.status !== input.status) throw new ProjectApiError(409, 'This finding has already been reviewed.');
    const reviewed = { ...finding.geometry, review: { user_id: this.userId, reviewed_at: new Date().toISOString() } };
    result(await this.writer.from('plan_reading_findings').update({ status: input.status, geometry: reviewed }).eq('workspace_id', this.workspaceId).eq('job_id', id).eq('id', finding.id));
    return { ...finding, status: input.status, geometry: reviewed };
  }
}

export async function handleGeminiPlanRequest(request: Request, db: SupabaseLike, writer: SupabaseLike, storage: AiPlanStorage, reader: PlanReader, alternatives: Partial<Record<PlanProvider, PlanReader>> = {}) {
  try {
    const { data, error } = await db.auth.getUser();
    if (error || !data.user) throw new ProjectApiError(401, 'Authentication required');
    const workspaceId = request.headers.get('x-workspace-id');
    if (!workspaceId) throw new ProjectApiError(400, 'x-workspace-id header is required');
    const service = new GeminiPlanService(db, writer, storage, reader, workspaceId, data.user.id, alternatives);
    const path = new URL(request.url).pathname.split('/').filter(Boolean);
    if (path[1] === 'projects' && path.length === 4 && request.method === 'POST') return Response.json(await service.create(path[2]!, await request.json()), { status: 202 });
    if (path[1] === 'ai-plan-readings' && path[2]) {
      if (path.length === 3 && request.method === 'GET') return Response.json(await service.get(path[2]));
      if (path.length === 3 && request.method === 'PATCH') return Response.json(await service.review(path[2], await request.json()));
      if (path.length === 4 && path[3] === 'process' && request.method === 'POST') return Response.json(await service.process(path[2]));
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  } catch (error) {
    if (error instanceof ProjectApiError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return Response.json({ error: 'Invalid JSON request.' }, { status: 400 });
    return Response.json({ error: 'AI processing failed. Please retry.' }, { status: 500 });
  }
}
