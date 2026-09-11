import { downloadPlan } from '../billing/project-preflight.ts';
import { ProjectApiError, assertPlanStoragePath, type SupabaseLike } from '../projects/service.ts';
import type { AiPlanObjectStorage, PlanReadingFindingsWriter } from '../ai-plan/service.ts';
import { runDeepTakeoff, type DeepRunSummary } from './orchestrator.ts';
import { createPlanSetManifest } from './preflight.ts';
import type {
  DeepCheckpointRepository,
  DeepPassProvider,
  DeepPassRequest,
  DeepPassResult,
  PlanSetManifest,
} from './types.ts';

export const FULL_TAKEOFF_V2_MODE = 'full_v2';
export const FULL_TAKEOFF_V2_ORCHESTRATOR_VERSION = 'takeoff-v2.1';

export interface FullTakeoffV2ProviderFactory {
  create(input: {
    fileBytes: Uint8Array;
    manifest: PlanSetManifest;
    runId: string;
    workspaceId: string;
    projectId: string;
    fileId: string;
  }): DeepPassProvider | Promise<DeepPassProvider>;
}

export interface FullTakeoffV2Persistence {
  prepare(input: {
    manifest: PlanSetManifest;
    workspaceId: string;
    projectId: string;
    fileId: string;
    requestedBy: string;
  }): Promise<{
    runId: string;
    resumed: boolean;
    checkpoints: DeepCheckpointRepository;
    completedStatus?: 'needs_review' | 'ready';
  }>;
  finish(runId: string, summary: DeepRunSummary): Promise<'needs_review' | 'failed'>;
}

function result<T>(value: { data: T; error: { message?: string; code?: string } | null }, message: string): T {
  if (value.error) throw new ProjectApiError(500, message);
  return value.data;
}

/** Service-role persistence for the additive V2 tables. Browser roles remain read-only. */
export class SupabaseFullTakeoffV2Persistence implements FullTakeoffV2Persistence {
  private readonly writer: PlanReadingFindingsWriter;
  private readonly ownedRuns = new Map<string, {
    workspaceId: string; projectId: string; fileId: string; fileSha256: string; updatedAt: string;
  }>();
  constructor(writer: PlanReadingFindingsWriter) { this.writer = writer; }

  async prepare(input: {
    manifest: PlanSetManifest;
    workspaceId: string;
    projectId: string;
    fileId: string;
    requestedBy: string;
  }) {
    const findRun = async () => result<any>(
      await this.writer.from('takeoff_runs').select('*')
        .eq('workspace_id', input.workspaceId).eq('project_id', input.projectId)
        .eq('file_id', input.fileId).eq('file_sha256', input.manifest.fileSha256)
        .eq('mode', 'full').eq('orchestrator_version', FULL_TAKEOFF_V2_ORCHESTRATOR_VERSION).maybeSingle(),
      'Could not read the Full Takeoff run.',
    );

    let run = await findRun();
    let createdHere = false;
    if (!run) {
      const now = new Date().toISOString();
      const inserted = await this.writer.from('takeoff_runs').insert({
        workspace_id: input.workspaceId,
        project_id: input.projectId,
        file_id: input.fileId,
        mode: 'full',
        status: 'processing',
        file_sha256: input.manifest.fileSha256,
        orchestrator_version: FULL_TAKEOFF_V2_ORCHESTRATOR_VERSION,
        requested_by: input.requestedBy,
        started_at: now,
        updated_at: now,
      }).select('*').single();
      if (inserted.error?.code === '23505') run = await findRun();
      else {
        run = result<any>(inserted, 'Could not create the Full Takeoff run.');
        createdHere = true;
      }
    }
    if (!run?.id) throw new ProjectApiError(500, 'Full Takeoff run identity is unavailable.');

    // The successful unique INSERT owns this run. Time passing is not evidence
    // that a previous provider call was free or stopped. Never reclaim a failed,
    // queued, cancelled, or uncertain processing run through this endpoint.
    let completedStatus: 'needs_review' | 'ready' | undefined;
    if (!createdHere) {
      if (run.status !== 'needs_review' && run.status !== 'ready') {
        throw new ProjectApiError(409, 'Full Takeoff run is in progress or requires reconciliation. No repeat run was started.');
      }
      completedStatus = run.status;
    } else if (typeof run.updated_at !== 'string' || !Number.isFinite(Date.parse(run.updated_at))) {
      throw new ProjectApiError(500, 'Full Takeoff run claim could not be verified.');
    }

    if (createdHere) {
      const sheetRows = input.manifest.sheets.map(sheet => ({
        takeoff_run_id: run.id,
        workspace_id: input.workspaceId,
        project_id: input.projectId,
        file_id: input.fileId,
        physical_page_number: sheet.physicalPageNumber,
        page_sha256: sheet.pageSha256,
        width_points: sheet.widthPoints,
        height_points: sheet.heightPoints,
        rotation_degrees: sheet.rotationDegrees,
        content_kind: sheet.contentKind,
        text_quality: sheet.textQuality,
        status: sheet.status,
        status_reason: sheet.statusReason,
      }));
      result(
        await this.writer.from('plan_sheets').insert(sheetRows),
        'Could not persist the physical-page manifest.',
      );
    }
    // Completed runs are read-only: do not reset human classifications, review
    // decisions, timestamps, or checkpoints while reconstructing their summary.
    const persistedSheets = result<any[]>(
      await this.writer.from('plan_sheets').select('id, physical_page_number')
        .eq('takeoff_run_id', run.id).eq('workspace_id', input.workspaceId).eq('project_id', input.projectId),
      'Could not read the physical-page manifest.',
    );
    if (!Array.isArray(persistedSheets) || persistedSheets.length !== input.manifest.physicalPageCount) {
      throw new ProjectApiError(409, 'The persisted Full Takeoff manifest does not account for every physical page.');
    }
    const sheetIds = new Map<number, string>(persistedSheets.map(sheet => [Number(sheet.physical_page_number), String(sheet.id ?? '')]));
    if (sheetIds.size !== input.manifest.physicalPageCount || [...sheetIds.values()].some(id => !id)
      || input.manifest.sheets.some(sheet => !sheetIds.has(sheet.physicalPageNumber))) {
      throw new ProjectApiError(409, 'The persisted Full Takeoff manifest contains duplicate or invalid page identities.');
    }
    if (createdHere) {
      this.ownedRuns.set(String(run.id), {
        workspaceId: input.workspaceId, projectId: input.projectId, fileId: input.fileId,
        fileSha256: input.manifest.fileSha256, updatedAt: run.updated_at,
      });
    }
    return {
      runId: String(run.id),
      resumed: !createdHere,
      ...(completedStatus ? { completedStatus } : {}),
      checkpoints: new SupabaseDeepCheckpointRepository(this.writer, String(run.id), input.workspaceId, input.projectId, sheetIds, !createdHere),
    };
  }

  async finish(runId: string, summary: DeepRunSummary): Promise<'needs_review' | 'failed'> {
    const claim = this.ownedRuns.get(runId);
    if (!claim) throw new ProjectApiError(409, 'This execution does not own the Full Takeoff run.');
    const status = summary.failed > 0 ? 'failed' : 'needs_review';
    const updated = result<{ id: string } | null>(
      await this.writer.from('takeoff_runs').update({
        status,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', runId).eq('workspace_id', claim.workspaceId).eq('project_id', claim.projectId)
        .eq('file_id', claim.fileId).eq('file_sha256', claim.fileSha256)
        .eq('mode', 'full').eq('orchestrator_version', FULL_TAKEOFF_V2_ORCHESTRATOR_VERSION)
        .eq('status', 'processing').eq('updated_at', claim.updatedAt).select('id').maybeSingle(),
      'Could not finish the Full Takeoff run.',
    );
    if (!updated) throw new ProjectApiError(409, 'Full Takeoff run ownership changed. Its saved state was not overwritten.');
    this.ownedRuns.delete(runId);
    return status;
  }
}

export class SupabaseDeepCheckpointRepository implements DeepCheckpointRepository {
  private readonly writer: PlanReadingFindingsWriter;
  private readonly runId: string;
  private readonly workspaceId: string;
  private readonly projectId: string;
  private readonly sheetIds: ReadonlyMap<number, string>;
  private readonly readOnly: boolean;
  constructor(
    writer: PlanReadingFindingsWriter,
    runId: string,
    workspaceId: string,
    projectId: string,
    sheetIds: ReadonlyMap<number, string>,
    readOnly = false,
  ) {
    this.writer = writer;
    this.runId = runId;
    this.workspaceId = workspaceId;
    this.projectId = projectId;
    this.sheetIds = sheetIds;
    this.readOnly = readOnly;
  }

  private sheetId(request: DeepPassRequest): string {
    if (request.runId !== this.runId) throw new ProjectApiError(409, 'Checkpoint does not belong to this Full Takeoff run.');
    const id = this.sheetIds.get(request.sheet.physicalPageNumber);
    if (!id) throw new ProjectApiError(409, `Physical page ${request.sheet.physicalPageNumber} is absent from the manifest.`);
    return id;
  }

  async begin(request: DeepPassRequest): Promise<'run' | 'already_succeeded' | 'already_blocked'> {
    const sheetId = this.sheetId(request);
    const readExisting = async () => result<{ status: string; idempotency_key: string } | null>(
      await this.writer.from('takeoff_passes').select('status, idempotency_key')
        .eq('takeoff_run_id', this.runId).eq('workspace_id', this.workspaceId).eq('project_id', this.projectId)
        .eq('plan_sheet_id', sheetId).eq('pass_type', request.passType).eq('attempt', request.attempt).maybeSingle(),
      'Could not read a Full Takeoff checkpoint.',
    );
    const reuse = (existing: { status: string; idempotency_key: string } | null): 'already_succeeded' | 'already_blocked' => {
      if (!existing || existing.idempotency_key !== request.idempotencyKey) {
        throw new ProjectApiError(409, 'Full Takeoff checkpoint identity conflicts with the saved attempt.');
      }
      if (existing.status === 'succeeded') return 'already_succeeded';
      if (existing.status === 'blocked') return 'already_blocked';
      // Processing and uncertain/failed outcomes may already have spent money.
      // No lease expiry, retry, or overwrite is safe without reconciliation.
      throw new ProjectApiError(409, 'Full Takeoff checkpoint is in progress or requires reconciliation. No repeat call was started.');
    };
    const existing = await readExisting();
    if (existing) return reuse(existing);
    if (this.readOnly) throw new ProjectApiError(409, 'A completed Full Takeoff run has a missing checkpoint. No new call was started.');

    // INSERT, never UPSERT: the existing database unique keys elect exactly one
    // caller. A stale concurrent read must not grant a second provider dispatch.
    const inserted = await this.writer.from('takeoff_passes').insert({
      takeoff_run_id: this.runId,
      workspace_id: this.workspaceId,
      project_id: this.projectId,
      plan_sheet_id: sheetId,
      pass_type: request.passType,
      attempt: request.attempt,
      status: 'processing',
      idempotency_key: request.idempotencyKey,
      failure_classification: null,
      started_at: new Date().toISOString(),
      completed_at: null,
    });
    if (inserted.error?.code === '23505') return reuse(await readExisting());
    result(inserted, 'Could not begin a Full Takeoff checkpoint.');
    return 'run';
  }

  async succeed(request: DeepPassRequest, pass: DeepPassResult): Promise<void> {
    if (this.readOnly) throw new ProjectApiError(409, 'Completed Full Takeoff checkpoints are read-only.');
    const sheetId = this.sheetId(request);
    const updated = result<{ id: string } | null>(
      await this.writer.from('takeoff_passes').update({
        status: pass.status === 'blocked' ? 'blocked' : 'succeeded',
        checkpoint: pass.checkpoint,
        provider: pass.provider ?? null,
        model: pass.model ?? null,
        input_tokens: pass.inputTokens ?? null,
        output_tokens: pass.outputTokens ?? null,
        completed_at: new Date().toISOString(),
      }).eq('takeoff_run_id', this.runId).eq('workspace_id', this.workspaceId).eq('project_id', this.projectId)
        .eq('plan_sheet_id', sheetId).eq('pass_type', request.passType).eq('attempt', request.attempt)
        .eq('idempotency_key', request.idempotencyKey).eq('status', 'processing').select('id').maybeSingle(),
      'Could not save a Full Takeoff checkpoint.',
    );
    if (!updated) throw new ProjectApiError(409, 'Full Takeoff checkpoint is no longer processing. Its saved result was not overwritten.');
  }

  async fail(request: DeepPassRequest, failure: { classification: string; message: string }): Promise<void> {
    if (this.readOnly) throw new ProjectApiError(409, 'Completed Full Takeoff checkpoints are read-only.');
    const sheetId = this.sheetId(request);
    const updated = result<{ id: string } | null>(
      await this.writer.from('takeoff_passes').update({
        status: 'failed',
        failure_classification: failure.classification,
        checkpoint: { error: failure.message },
        completed_at: new Date().toISOString(),
      }).eq('takeoff_run_id', this.runId).eq('workspace_id', this.workspaceId).eq('project_id', this.projectId)
        .eq('plan_sheet_id', sheetId).eq('pass_type', request.passType).eq('attempt', request.attempt)
        .eq('idempotency_key', request.idempotencyKey).eq('status', 'processing').select('id').maybeSingle(),
      'Could not save a failed Full Takeoff checkpoint.',
    );
    if (!updated) throw new ProjectApiError(409, 'Full Takeoff checkpoint is no longer processing. Its saved result was not overwritten.');
  }
}

/** Explicit Full/Deep boundary. Quick and Pilot never call this service. */
export class FullTakeoffV2Service {
  private readonly db: SupabaseLike;
  private readonly storage: AiPlanObjectStorage;
  private readonly persistence: FullTakeoffV2Persistence;
  private readonly providerFactory: FullTakeoffV2ProviderFactory;
  private readonly userId: string;
  private readonly workspaceId: string;
  private readonly fetcher: typeof fetch;
  constructor(
    db: SupabaseLike,
    storage: AiPlanObjectStorage,
    persistence: FullTakeoffV2Persistence,
    providerFactory: FullTakeoffV2ProviderFactory,
    userId: string,
    workspaceId: string,
    fetcher: typeof fetch = fetch,
  ) {
    this.db = db;
    this.storage = storage;
    this.persistence = persistence;
    this.providerFactory = providerFactory;
    this.userId = userId;
    this.workspaceId = workspaceId;
    this.fetcher = fetcher;
  }

  async create(projectId: string, input: Record<string, unknown>) {
    if (input.mode !== FULL_TAKEOFF_V2_MODE) throw new ProjectApiError(400, 'mode must be full_v2.');
    const fileId = typeof input.file_id === 'string' ? input.file_id.trim() : '';
    if (!fileId) throw new ProjectApiError(400, 'file_id is required.');

    const workspace = result<any>(
      await this.db.from('workspaces').select('ai_processing_consented_at').eq('id', this.workspaceId).maybeSingle(),
      'Could not verify AI processing consent.',
    );
    if (!workspace?.ai_processing_consented_at) throw new ProjectApiError(403, 'AI processing consent is required before Full Takeoff.');
    const membership = result<any>(
      await this.db.from('workspace_members').select('role').eq('workspace_id', this.workspaceId).eq('user_id', this.userId).maybeSingle(),
      'Could not verify workspace access.',
    );
    if (!membership || !['admin', 'estimator'].includes(membership.role)) throw new ProjectApiError(403, 'Admin or estimator access is required for Full Takeoff.');
    const project = result<any>(
      await this.db.from('projects').select('id').eq('workspace_id', this.workspaceId).eq('id', projectId).maybeSingle(),
      'Could not verify the project.',
    );
    if (!project) throw new ProjectApiError(404, 'Project not found.');
    const file = result<any>(
      await this.db.from('project_files').select('id, storage_path, processing_status, page_count')
        .eq('workspace_id', this.workspaceId).eq('project_id', projectId).eq('id', fileId).maybeSingle(),
      'Could not verify the plan file.',
    );
    if (!file) throw new ProjectApiError(404, 'Plan file not found.');
    if (file.processing_status === 'uploading' || file.processing_status === 'failed') {
      throw new ProjectApiError(409, 'Plan file must finish uploading before Full Takeoff can start.');
    }

    assertPlanStoragePath(file.storage_path, this.workspaceId, projectId, fileId);
    const signed = await this.storage.presign('GET', file.storage_path, { expiresIn: 300 });
    const fileBytes = await downloadPlan(signed.url, this.fetcher);
    let manifest: PlanSetManifest;
    try {
      manifest = await createPlanSetManifest(fileBytes);
    } catch {
      throw new ProjectApiError(422, 'The uploaded file could not be deterministically preflighted as a PDF.');
    }
    if (Number.isInteger(file.page_count) && file.page_count > 0 && file.page_count !== manifest.physicalPageCount) {
      throw new ProjectApiError(409, 'Stored page count does not match deterministic Full Takeoff preflight.');
    }

    const prepared = await this.persistence.prepare({
      manifest,
      workspaceId: this.workspaceId,
      projectId,
      fileId,
      requestedBy: this.userId,
    });
    // Rebuilding a completed summary must not initialize or contact a provider.
    const provider: DeepPassProvider = prepared.completedStatus
      ? { runPass: async () => { throw new ProjectApiError(409, 'Completed Full Takeoff cannot start another provider call.'); } }
      : await this.providerFactory.create({ fileBytes, manifest, runId: prepared.runId,
        workspaceId: this.workspaceId, projectId, fileId });
    if (!provider || typeof provider.runPass !== 'function') throw new ProjectApiError(503, 'Full Takeoff provider is not configured.');
    const summary = await runDeepTakeoff(prepared.runId, manifest, provider, prepared.checkpoints);
    const status = prepared.completedStatus ?? await this.persistence.finish(prepared.runId, summary);
    const releaseStatus = summary.failed > 0 || summary.blocked > 0
      || summary.sheets.some(sheet => sheet.passesCompleted !== sheet.passesTotal || sheet.status === 'blocked')
      ? 'blocked' as const
      : 'review_ready' as const;
    return {
      id: prepared.runId,
      mode: FULL_TAKEOFF_V2_MODE,
      status,
      resumed: prepared.resumed,
      manifest,
      summary,
      output_summary: {
        takeoff_v2: {
          mode: FULL_TAKEOFF_V2_MODE,
          releaseStatus,
          sheets: summary.sheets,
        },
      },
    };
  }
}
