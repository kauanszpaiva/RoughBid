import { downloadPlan } from '../billing/project-preflight.ts';
import { withUsageMeter } from '../owner-usage/meter.ts';
import { ProjectApiError, assertPlanStoragePath, type SupabaseLike } from '../projects/service.ts';
import type { AiPlanObjectStorage, PlanReadingFindingsWriter } from '../ai-plan/service.ts';
import type { DurableQueueModule } from '../ai-plan/durable.ts';
import { createPlanSetManifest } from './preflight.ts';
import { DEEP_PASS_ORDER, runDeepTakeoff } from './orchestrator.ts';
import { FULL_TAKEOFF_V2_MODE, type FullTakeoffV2ProviderFactory } from './service.ts';
import type { DeepCheckpointRepository, DeepPassRequest, DeepPassResult, PlanSetManifest } from './types.ts';
import type { AutomaticGeometryCoordinator } from './automatic-geometry.ts';
import { approveFullTakeoffSpend, fullTakeoffApprovalProfile } from './user-spend-approval.ts';
import { fullTakeoffConsumerPresent, type PresenceRedis } from './worker-presence.ts';
import { hashPaidFullContract, validatePaidFullContract } from '../billing/full-takeoff-pricing.ts';
import { paidFullRunLimits } from './paid-access.ts';
import { FullTakeoffBudgetWait, FullTakeoffRunBudgetExhausted } from './budget-wait.ts';

export const FULL_TAKEOFF_V2_QUEUE = 'takeoff-full-v2';
export const FULL_TAKEOFF_V2_DURABLE_VERSION = 'takeoff-v2.2-durable';

export interface FullTakeoffV2Queue {
  isWorkerAvailable(): Promise<boolean>;
  add(runId: string): Promise<unknown>;
  close?(): Promise<void>;
}

/** A missed enqueue is harmless: SQL remains the durable source on every scan. */
export async function requeueDueFullTakeoffBudgetRuns(writer: PlanReadingFindingsWriter,
  queue: Pick<FullTakeoffV2Queue,'add'>): Promise<number> {
  if (!writer.rpc) throw new Error('Full Takeoff budget recovery requires persistence.');
  const due = await writer.rpc('due_full_takeoff_budget_runs',{p_version:FULL_TAKEOFF_V2_DURABLE_VERSION});
  if (due.error || !Array.isArray(due.data)) throw new Error('Full Takeoff budget recovery unavailable.');
  let count = 0;
  for (const row of due.data) {
    if (typeof row?.run_id !== 'string' || !/^[a-f0-9-]{36}$/i.test(row.run_id)) throw new Error('Invalid durable reading identity.');
    await queue.add(row.run_id); count++;
  }
  return count;
}

export async function createFullTakeoffV2Queue(redisUrl: string,
  loader: () => Promise<DurableQueueModule> = () => import('bullmq') as unknown as Promise<DurableQueueModule>,
): Promise<FullTakeoffV2Queue> {
  if (!redisUrl) throw new Error('REDIS_URL is required for durable Full Takeoff.');
  const bull = await loader();
  const queue = new bull.Queue(FULL_TAKEOFF_V2_QUEUE, { connection: {
    url: redisUrl, maxRetriesPerRequest: 1, enableOfflineQueue: false, autoResendUnfulfilledCommands: false,
    connectTimeout: 5_000, commandTimeout: 5_000, retryStrategy: () => null,
  } });
  (queue as unknown as { on?: (event: string, listener: () => void) => unknown }).on?.('error', () => {
    console.error('[full-takeoff-queue] Redis connection unavailable');
  });
  return {
    async isWorkerAvailable() {
      return fullTakeoffConsumerPresent((queue as unknown as { client: Promise<PresenceRedis> }).client);
    },
    add(runId) {
      // Retries recover transport/process crashes. The SQL pass claims never
      // redispatch an uncertain provider call, even after its worker lease ends.
      return queue.add('full-takeoff', { runId }, {
        jobId: runId, attempts: 3, backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true, removeOnFail: true,
      });
    },
    close: () => queue.close(),
  };
}

function dbValue<T>(value: { data: T; error: unknown }, message: string): T {
  if (value.error) throw new ProjectApiError(503, message);
  return value.data;
}

/** Called after signed payment reconciliation, or by an authenticated retry.
 * The database independently validates payment and atomically owns one run. */
export async function ensurePaidFullRun(writer: PlanReadingFindingsWriter, queue: FullTakeoffV2Queue, quoteId: string,
  actor?: { userId: string; workspaceId: string; projectId: string; fileId: string }) {
  if (!writer.rpc) throw new ProjectApiError(503, 'Paid Full persistence is unavailable.');
  let query = writer.from('project_reading_quotes').select('id,user_id,workspace_id,project_id,file_id,mode,status,livemode,paid_at,full_contract,full_contract_hash');
  query = query.eq('id', quoteId).eq('mode', 'full_v2');
  if (actor) query = query.eq('user_id', actor.userId).eq('workspace_id', actor.workspaceId).eq('project_id', actor.projectId).eq('file_id', actor.fileId);
  const quote = dbValue<any>(await query.maybeSingle(), 'Could not read the paid Full quote.');
  if (!quote || quote.livemode !== true || !quote.paid_at || !['paid','processing','complete','failed'].includes(quote.status)) {
    throw new ProjectApiError(403, 'Confirmed live payment for this Full reading is required.');
  }
  const contract = validatePaidFullContract(quote.full_contract, process.env);
  if (hashPaidFullContract(contract) !== quote.full_contract_hash) throw new ProjectApiError(409, 'The paid Full contract does not match its saved revision.');
  const live = await writer.rpc('full_takeoff_v2_worker_available', { p_version: FULL_TAKEOFF_V2_DURABLE_VERSION });
  if (live.error || live.data !== true || !await queue.isWorkerAvailable()) throw new ProjectApiError(503, 'The paid reading is saved and awaits an available Full worker.');
  const reserved = await writer.rpc('reserve_paid_full_takeoff_v2', { p_quote_id: quote.id, p_user_id: quote.user_id,
    p_workspace_id: quote.workspace_id, p_project_id: quote.project_id, p_file_id: quote.file_id,
    p_contract_hash: quote.full_contract_hash, p_version: FULL_TAKEOFF_V2_DURABLE_VERSION });
  if (reserved.error || !reserved.data?.run?.id) throw new ProjectApiError(409, 'Paid Full reservation was not authorized. Payment state and saved evidence were preserved.');
  const payload = reserved.data;
  if (payload.run.status === 'queued') {
    try { await queue.add(payload.run.id); }
    catch { throw new ProjectApiError(503, 'The paid Full run is saved. Retry will reuse this run after queue recovery.'); }
  }
  return { ...payload.run, mode: FULL_TAKEOFF_V2_MODE, resumed: payload.reused === true };
}

/** HTTP only reserves/enqueues. Provider credentials and calls stay on the worker. */
export class DurableFullTakeoffV2Service {
  private readonly db: SupabaseLike;
  private readonly writer: PlanReadingFindingsWriter;
  private readonly storage: AiPlanObjectStorage;
  private readonly queue: FullTakeoffV2Queue | undefined;
  private readonly userId: string;
  private readonly workspaceId: string;
  private readonly fetcher: typeof fetch;
  private readonly automaticGeometry: AutomaticGeometryCoordinator | undefined;
  constructor(db: SupabaseLike, writer: PlanReadingFindingsWriter,
    storage: AiPlanObjectStorage, queue: FullTakeoffV2Queue | undefined,
    userId: string, workspaceId: string, fetcher: typeof fetch = fetch, automaticGeometry?:AutomaticGeometryCoordinator) {
    this.db = db; this.writer = writer; this.storage = storage; this.queue = queue;
    this.userId = userId; this.workspaceId = workspaceId; this.fetcher = fetcher;
    this.automaticGeometry = automaticGeometry;
  }

  private async ready() {
    if (!this.writer.rpc || !this.queue) throw new ProjectApiError(503, 'Full Takeoff V2 durable queue is not configured. No run was started.');
    const live = await this.writer.rpc('full_takeoff_v2_worker_available', { p_version: FULL_TAKEOFF_V2_DURABLE_VERSION });
    if (live.error || live.data !== true || !(await this.queue.isWorkerAvailable())) {
      throw new ProjectApiError(503, 'A live Full Takeoff V2 worker with compatible schema is not available. No run was started.');
    }
  }

  async reserve(projectId: string, input: Record<string, unknown>) {
    if (input.mode !== FULL_TAKEOFF_V2_MODE) throw new ProjectApiError(400, 'mode must be full_v2.');
    if (Object.prototype.hasOwnProperty.call(input, 'page_number')) throw new ProjectApiError(400, 'Full Takeoff analyzes the complete plan set; page_number is not supported.');
    const fileId = typeof input.file_id === 'string' ? input.file_id.trim() : '';
    if (!fileId) throw new ProjectApiError(400, 'file_id is required.');
    await this.ready();
    if (Object.hasOwn(input, 'quote_id')) {
      if (typeof input.quote_id !== 'string' || !input.quote_id.trim()) throw new ProjectApiError(400, 'A paid Full quote is required.');
      return ensurePaidFullRun(this.writer, this.queue!, input.quote_id, { userId: this.userId, workspaceId: this.workspaceId, projectId, fileId });
    }
    const spendApproval = approveFullTakeoffSpend(input.spend_approval, fullTakeoffApprovalProfile(process.env), this.userId);
    const membership = dbValue<any>(await this.db.from('workspace_members').select('role')
      .eq('workspace_id', this.workspaceId).eq('user_id', this.userId).maybeSingle(), 'Could not verify workspace access.');
    if (!membership || !['admin', 'estimator'].includes(membership.role)) throw new ProjectApiError(403, 'Admin or estimator access is required for Full Takeoff.');
    const workspace = dbValue<any>(await this.db.from('workspaces').select('ai_processing_consented_at')
      .eq('id', this.workspaceId).maybeSingle(), 'Could not verify AI processing consent.');
    if (!workspace?.ai_processing_consented_at) throw new ProjectApiError(403, 'AI processing consent is required before Full Takeoff.');
    const file = dbValue<any>(await this.db.from('project_files').select('id,storage_path,processing_status,page_count')
      .eq('workspace_id', this.workspaceId).eq('project_id', projectId).eq('id', fileId).maybeSingle(), 'Could not verify the plan file.');
    if (!file) throw new ProjectApiError(404, 'Plan file not found.');
    if (['uploading', 'failed'].includes(file.processing_status)) throw new ProjectApiError(409, 'Plan file must finish uploading before Full Takeoff can start.');
    assertPlanStoragePath(file.storage_path, this.workspaceId, projectId, fileId);
    const signed = await this.storage.presign('GET', file.storage_path, { expiresIn: 300 });
    const bytes = await downloadPlan(signed.url, this.fetcher);
    let manifest: PlanSetManifest;
    try { manifest = await createPlanSetManifest(bytes); }
    catch { throw new ProjectApiError(422, 'The uploaded file could not be deterministically preflighted as a PDF.'); }
    manifest.spendApproval = spendApproval;
    if (manifest.physicalPageCount > 200) throw new ProjectApiError(422, 'Full Takeoff V2 supports at most 200 physical PDF pages per run.');
    if (Number.isInteger(file.page_count) && file.page_count > 0 && file.page_count !== manifest.physicalPageCount) {
      throw new ProjectApiError(409, 'Stored page count does not match deterministic Full Takeoff preflight.');
    }
    const reserved = await this.writer.rpc!('reserve_full_takeoff_v2', {
      p_user_id: this.userId, p_workspace_id: this.workspaceId, p_project_id: projectId,
      p_file_id: fileId, p_manifest: manifest, p_version: FULL_TAKEOFF_V2_DURABLE_VERSION,
    });
    if (reserved.error) throw new ProjectApiError(409, 'Full Takeoff V2 reservation could not be authorized. No provider call was started.');
    const payload = reserved.data as { run?: any; reused?: boolean };
    if (!payload?.run?.id) throw new ProjectApiError(503, 'Full Takeoff V2 reservation did not return a run.');
    // HTTP enqueues only the durable parent. Page fanout happens under its
    // worker lease, with stable child identities recoverable after a restart.
    const geometry=this.automaticGeometry?{state:'deferred_to_durable_worker',requestedPages:manifest.physicalPageCount,coverage:'pending'}:undefined;
    if (payload.run.status === 'queued') await this.enqueue(String(payload.run.id));
    return { ...payload.run, mode: FULL_TAKEOFF_V2_MODE, resumed: payload.reused === true,...(geometry?{automaticGeometry:geometry}:{}) };
  }

  private async enqueue(runId: string) {
    try { await this.queue!.add(runId); }
    catch { throw new ProjectApiError(503, 'Full Takeoff queue acknowledgement failed. The queued run is saved; retry reuses its identity.'); }
  }

  async get(runId: string) {
    const run = dbValue<any>(await this.db.from('takeoff_runs')
      .select('id,workspace_id,project_id,file_id,file_sha256,status,payment_kind,orchestrator_version,progress,output_summary,created_at,started_at,completed_at,updated_at,cancel_requested_at,processing_error,not_before,waiting_reason,error_code')
      .eq('id', runId).eq('workspace_id', this.workspaceId).eq('mode', 'full')
      .eq('orchestrator_version', FULL_TAKEOFF_V2_DURABLE_VERSION).maybeSingle(), 'Could not read Full Takeoff progress.');
    if (!run) throw new ProjectApiError(404, 'Full Takeoff run not found.');
    const passes = dbValue<any[]>(await this.db.from('takeoff_passes')
      .select('plan_sheet_id,pass_type,attempt,status,provider,model,failure_classification,started_at,completed_at')
      .eq('takeoff_run_id', runId).eq('workspace_id', this.workspaceId).eq('project_id', run.project_id), 'Could not read Full Takeoff checkpoints.');
    const sheets = dbValue<any[]>(await this.db.from('plan_sheets')
      .select('id,physical_page_number,status,status_reason')
      .eq('takeoff_run_id', runId).eq('workspace_id', this.workspaceId).eq('project_id', run.project_id), 'Could not read Full Takeoff sheets.');
    const reviewed = dbValue<any[]>(await this.db.from('takeoff_measurement_reviews').select('review_status')
      .eq('takeoff_run_id', runId).eq('workspace_id', this.workspaceId).eq('project_id', run.project_id).limit(501), 'Could not read Full Takeoff measurement coverage.');
    const automaticGeometry=this.automaticGeometry?await this.automaticGeometry.summary({workspaceId:this.workspaceId,projectId:run.project_id,
      fileId:run.file_id,fileSha256:run.file_sha256,expectedPages:sheets.length}):undefined;
    return { ...run, mode: FULL_TAKEOFF_V2_MODE,...(automaticGeometry?{automaticGeometry}:{}), sheets: sheets.map(sheet => ({ ...sheet,
      passes: passes.filter(pass => pass.plan_sheet_id === sheet.id) })), measurementReview: {
        acceptedCount: reviewed.slice(0,500).filter(value=>value.review_status==='accepted').length,
        pendingCount: reviewed.slice(0,500).filter(value=>['candidate','blocked'].includes(value.review_status)).length,
        countsPartial: reviewed.length>500, endpoint:`/api/takeoff-runs/${encodeURIComponent(runId)}/measurements`,
        scopeCoverage:'selected_elements_only', humanReviewRequired:true,
      } };
  }

  async checkpoint(runId: string, page: number, passType: string, regionKey?: string) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 200 || !DEEP_PASS_ORDER.includes(passType as any)) {
      throw new ProjectApiError(400, 'Select one physical page and one valid pass to read its checkpoint.');
    }
    const run = dbValue<any>(await this.db.from('takeoff_runs').select('id,project_id')
      .eq('id', runId).eq('workspace_id', this.workspaceId).eq('mode', 'full')
      .eq('orchestrator_version', FULL_TAKEOFF_V2_DURABLE_VERSION).maybeSingle(), 'Could not read Full Takeoff run.');
    if (!run) throw new ProjectApiError(404, 'Full Takeoff run not found.');
    const sheet = dbValue<any>(await this.db.from('plan_sheets').select('id,physical_page_number,status,status_reason')
      .eq('takeoff_run_id', runId).eq('workspace_id', this.workspaceId).eq('project_id', run.project_id)
      .eq('physical_page_number', page).maybeSingle(), 'Could not read Full Takeoff sheet.');
    if (!sheet) throw new ProjectApiError(404, 'Full Takeoff sheet not found.');
    if(regionKey!==undefined){
      if(!/^r[1-3]c[1-3]g[23]$/.test(regionKey)||!['discipline','conflict_detection','completeness'].includes(passType))throw new ProjectApiError(400,'Select one persisted visual region and an applicable pass.');
      const region=dbValue<any>(await this.db.from('takeoff_region_checkpoints').select('region_key,region,status,result,started_at,completed_at')
        .eq('takeoff_run_id',runId).eq('workspace_id',this.workspaceId).eq('project_id',run.project_id).eq('plan_sheet_id',sheet.id)
        .eq('physical_page_number',page).eq('pass_type',passType).eq('region_key',regionKey).maybeSingle(),'Could not read the persisted regional evidence.');
      if(!region)throw new ProjectApiError(404,'Regional checkpoint not found.');
      return {id:runId,mode:FULL_TAKEOFF_V2_MODE,sheet,region:{key:region.region_key,rectangle:region.region,status:region.status},
        pass:{pass_type:passType,status:region.status,provider:region.result?.provider??null,model:region.result?.model??null,
          checkpoint:region.result?.checkpoint??null,started_at:region.started_at,completed_at:region.completed_at}};
    }
    const pass = dbValue<any>(await this.db.from('takeoff_passes')
      .select('pass_type,attempt,status,provider,model,checkpoint,failure_classification,started_at,completed_at')
      .eq('takeoff_run_id', runId).eq('workspace_id', this.workspaceId).eq('project_id', run.project_id)
      .eq('plan_sheet_id', sheet.id).eq('pass_type', passType).eq('attempt', 1).maybeSingle(), 'Could not read Full Takeoff checkpoint.');
    if (!pass) throw new ProjectApiError(404, 'Full Takeoff pass not found.');
    return { id: runId, mode: FULL_TAKEOFF_V2_MODE, sheet, pass };
  }

  async cancel(runId: string) {
    if (!this.writer.rpc) throw new ProjectApiError(503, 'Full Takeoff cancellation is unavailable.');
    const canceled = await this.writer.rpc('cancel_full_takeoff_v2', {
      p_run_id: runId, p_user_id: this.userId, p_workspace_id: this.workspaceId,
    });
    if (canceled.error) throw new ProjectApiError(409, 'Full Takeoff cancellation was not authorized.');
    if(this.automaticGeometry){
      try{return {...canceled.data,automaticGeometry:await this.automaticGeometry.cancel({runId,workspaceId:this.workspaceId,userId:this.userId})};}
      catch{return {...canceled.data,automaticGeometry:{state:'cancellation_confirmation_pending',reason:'The parent is cancelled. Child worker guards prevent further dispatch; reload child states to reconcile.'}};}
    }
    return canceled.data;
  }

  async restart(runId: string, spendInput?: unknown) {
    await this.ready();
    const run = dbValue<any>(await this.db.from('takeoff_runs').select('id,status,error_code,payment_kind,project_id,file_id,manifest')
      .eq('id',runId).eq('workspace_id',this.workspaceId).eq('mode','full')
      .eq('orchestrator_version',FULL_TAKEOFF_V2_DURABLE_VERSION).maybeSingle(), 'Could not verify the saved reading.');
    if (!run) throw new ProjectApiError(404,'Full Takeoff run not found.');
    if (run.status === 'failed' && run.error_code === 'reading_configuration_unavailable' && run.payment_kind === 'complimentary') {
      // A normal resume keeps the stale profile forever. Reauthorize only this
      // untouched failure; SQL independently rejects any prior funding/evidence.
      const spendApproval = approveFullTakeoffSpend(spendInput,fullTakeoffApprovalProfile(process.env),this.userId);
      const reserved = await this.writer.rpc!('reserve_full_takeoff_v2', {
        p_user_id:this.userId,p_workspace_id:this.workspaceId,p_project_id:run.project_id,p_file_id:run.file_id,
        p_manifest:{...run.manifest,spendApproval},p_version:FULL_TAKEOFF_V2_DURABLE_VERSION,
      });
      if (reserved.error || reserved.data?.run?.id !== runId || reserved.data.run.status !== 'queued') {
        throw new ProjectApiError(409,'This configuration failure cannot be retried until its saved evidence and processing setup are reviewed.');
      }
      await this.enqueue(runId);
      return reserved.data.run;
    }
    if (spendInput !== undefined) throw new ProjectApiError(409,'A saved reading with processing history cannot replace its original approval.');
    const restarted = await this.writer.rpc!('restart_full_takeoff_v2', {
      p_run_id: runId, p_user_id: this.userId, p_workspace_id: this.workspaceId,
    });
    if (restarted.error) throw new ProjectApiError(409, 'Full Takeoff has an uncertain pass or cannot be restarted. Reconcile the saved result before any repeat call.');
    await this.enqueue(runId);
    return restarted.data;
  }
}

/** Every mutation is fenced by the current SQL lease, including per-pass claims. */
class LeasedDeepCheckpointRepository implements DeepCheckpointRepository {
  private readonly rpc: (fn: string, args: Record<string, unknown>) => Promise<any>;
  private readonly runId: string;
  private readonly leaseId: string;
  private readonly assertActive: () => Promise<void>;
  private readonly progress: (value: unknown) => Promise<void>;
  constructor(rpc: (fn: string, args: Record<string, unknown>) => Promise<any>,
    runId: string, leaseId: string, assertActive: () => Promise<void>, progress: (value: unknown) => Promise<void>) {
    this.rpc = rpc; this.runId = runId; this.leaseId = leaseId; this.assertActive = assertActive; this.progress = progress;
  }

  private identity(request: DeepPassRequest) {
    if (request.runId !== this.runId) throw new Error('Full Takeoff checkpoint identity mismatch.');
    return { p_run_id: this.runId, p_lease_id: this.leaseId, p_page_number: request.sheet.physicalPageNumber,
      p_pass_type: request.passType, p_attempt: request.attempt, p_idempotency_key: request.idempotencyKey };
  }
  async inspect(request: DeepPassRequest) {
    await this.assertActive();
    const saved = await this.rpc('inspect_full_takeoff_v2_pass',this.identity(request));
    if (saved.error || !['run','already_succeeded','already_blocked'].includes(saved.data)) throw new Error('Full checkpoint cannot repeat uncertain evidence.');
    return saved.data as 'run'|'already_succeeded'|'already_blocked';
  }
  async begin(request: DeepPassRequest, eventId?: string) {
    await this.assertActive();
    const saved = await this.rpc(eventId ? 'begin_funded_full_takeoff_v2_pass' : 'begin_full_takeoff_v2_pass',
      { ...this.identity(request),...(eventId ? {p_event_id:eventId} : {}) });
    if (saved.error || !['run', 'already_succeeded', 'already_blocked'].includes(saved.data)) {
      throw new Error('Full Takeoff pass requires reconciliation. No repeat provider call was started.');
    }
    await this.progress({ page: request.sheet.physicalPageNumber, pass: request.passType, total: DEEP_PASS_ORDER.length });
    return saved.data as 'run' | 'already_succeeded' | 'already_blocked';
  }
  async succeed(request: DeepPassRequest, result: DeepPassResult) {
    await this.assertActive();
    const saved = await this.rpc('checkpoint_full_takeoff_v2_pass', { ...this.identity(request), p_result: result, p_failure: null });
    if (saved.error || saved.data !== true) throw new Error('Full Takeoff pass checkpoint was not saved by its current lease.');
  }
  async fail(request: DeepPassRequest, failure: { classification: string; message: string }) {
    await this.assertActive();
    const saved = await this.rpc('checkpoint_full_takeoff_v2_pass', { ...this.identity(request), p_result: null, p_failure: failure });
    if (saved.error || saved.data !== true) throw new Error('Full Takeoff failure checkpoint was not saved by its current lease.');
  }
}

export interface FullTakeoffV2WorkerJob {
  data: { runId: string };
  attemptsMade: number;
  opts: { attempts?: number };
  updateProgress?(value: unknown): Promise<void>;
}

export class DurableFullTakeoffV2Processor {
  private readonly writer: PlanReadingFindingsWriter;
  private readonly storage: AiPlanObjectStorage;
  private readonly factory: FullTakeoffV2ProviderFactory;
  private readonly workerId: string;
  private readonly fetcher: typeof fetch;
  private readonly options: { heartbeatMs?: number };
  constructor(writer: PlanReadingFindingsWriter, storage: AiPlanObjectStorage,
    factory: FullTakeoffV2ProviderFactory, workerId: string, fetcher: typeof fetch = fetch,
    options: { heartbeatMs?: number } = {}) {
    this.writer = writer; this.storage = storage; this.factory = factory; this.workerId = workerId;
    this.fetcher = fetcher; this.options = options;
  }

  async process(job: FullTakeoffV2WorkerJob) {
    if (!this.writer.rpc) throw new Error('Full Takeoff V2 durable schema is unavailable.');
    const rpc = (fn: string, args: Record<string, unknown>) => Promise.resolve(this.writer.rpc!(fn, args));
    const claimed = await rpc('claim_full_takeoff_v2', {
      p_run_id: job.data.runId, p_worker_id: this.workerId, p_version: FULL_TAKEOFF_V2_DURABLE_VERSION,
    });
    if (claimed.error) throw new Error('Full Takeoff V2 could not claim an authorized worker lease.');
    const context = claimed.data as any;
    if (context?.skip) return context;
    const leaseId = typeof context?.lease_id === 'string' ? context.lease_id : '';
    if (!leaseId) throw new Error('Full Takeoff V2 claim did not return a lease.');
    let stopped = false;
    const controller = new AbortController();
    const heartbeat = async () => {
      try {
        const touched = await rpc('heartbeat_full_takeoff_v2', {
          p_run_id: job.data.runId, p_lease_id: leaseId, p_worker_id: this.workerId,
        });
        if (touched.error || touched.data !== true) stopped = true;
      } catch { stopped = true; }
      if(stopped && !controller.signal.aborted)controller.abort(new Error('Full Takeoff execution authorization ended.'));
      return !stopped;
    };
    const assertActive = async () => {
      if (!(await heartbeat())) {
        throw new Error('Full Takeoff V2 stopped at its execution boundary. Saved checkpoints require reconciliation.');
      }
    };
    const timer = setInterval(() => { void heartbeat(); }, this.options.heartbeatMs ?? 5_000);
    let boundary = 'source_unavailable';
    try {
      await assertActive();
      assertPlanStoragePath(context.storage_path, context.workspace_id, context.project_id, context.file_id);
      const signed = await this.storage.presign('GET', context.storage_path, { expiresIn: 300 });
      const fileBytes = await downloadPlan(signed.url, this.fetcher);
      const manifest = await createPlanSetManifest(fileBytes);
      boundary = 'source_changed';
      if (manifest.fileSha256 !== context.manifest?.fileSha256 || manifest.physicalPageCount !== context.manifest?.physicalPageCount) {
        throw new Error('Full Takeoff plan identity changed after authorization.');
      }
      // The complete file hash proves the exact original bytes. Existing runs
      // retain their persisted page identities, including older PDF serializers.
      if (context.manifest.sheets?.length !== manifest.sheets.length || manifest.sheets.some((sheet,index) => {
        const saved = context.manifest.sheets[index];
        return saved?.physicalPageNumber !== sheet.physicalPageNumber || saved.widthPoints !== sheet.widthPoints
          || saved.heightPoints !== sheet.heightPoints || saved.rotationDegrees !== sheet.rotationDegrees;
      })) throw new Error('Full Takeoff physical page identity changed.');
      manifest.sheets = manifest.sheets.map((sheet,index) => ({...sheet,pageSha256:context.manifest.sheets[index].pageSha256}));
      boundary = 'consent_changed';
      if (context.manifest?.paidAuthorization) {
        if (context.manifest.paidAuthorization.approvedBy !== context.requested_by) throw new Error('Paid Full consent belongs to another requester.');
        manifest.paidAuthorization = context.manifest.paidAuthorization;
        paidFullRunLimits(manifest, process.env);
      } else {
        if (context.manifest?.spendApproval?.approvedBy !== context.requested_by) {
          throw new Error('Full Takeoff user spending approval is missing or belongs to another requester.');
        }
        manifest.spendApproval = context.manifest.spendApproval;
      }
      const checkpoints = new LeasedDeepCheckpointRepository(rpc, job.data.runId, leaseId, assertActive,
        async value => { await job.updateProgress?.(value).catch(() => {}); });
      const summary = await withUsageMeter({ writer: this.writer, userId: context.requested_by,
        workspaceId: context.workspace_id, projectId: context.project_id, jobId: job.data.runId, billing: 'paid' }, async () => {
        boundary = 'reading_configuration_unavailable';
        const provider = await this.factory.create({ fileBytes, manifest, runId: job.data.runId,
          workspaceId: context.workspace_id, projectId: context.project_id, fileId: context.file_id, leaseId,signal:controller.signal });
        await assertActive();
        boundary = 'provider_result_uncertain';
        return runDeepTakeoff(job.data.runId, manifest, provider, checkpoints);
      });
      await assertActive();
      const finished = await rpc('finish_full_takeoff_v2', { p_run_id: job.data.runId, p_lease_id: leaseId, p_summary: summary });
      if (finished.error || !finished.data) throw new Error('Full Takeoff V2 could not finalize its saved checkpoints.');
      return finished.data;
    } catch (error) {
      if (error instanceof FullTakeoffBudgetWait && !stopped) {
        clearInterval(timer);
        const waiting = await rpc('wait_full_takeoff_budget', {p_run_id:job.data.runId,p_lease_id:leaseId,
          p_event_id:error.eventId,p_page_number:error.request.sheet.physicalPageNumber,p_pass_type:error.request.passType,
          p_idempotency_key:error.request.idempotencyKey});
        if (!waiting.error && waiting.data?.status === 'waiting_budget') return waiting.data;
      }
      // Never persist provider exceptions, signed URLs, source plans or keys.
      await rpc('fail_full_takeoff_boundary', { p_run_id:job.data.runId,p_lease_id:leaseId,
        p_error_code:stopped ? 'reading_authorization_ended' : error instanceof FullTakeoffRunBudgetExhausted ? 'run_budget_exhausted' : boundary }).catch(() => {});
      throw new Error('Full Takeoff V2 execution stopped. Inspect saved progress; uncertain provider passes are never retried automatically.');
    } finally { clearInterval(timer); }
  }
}
