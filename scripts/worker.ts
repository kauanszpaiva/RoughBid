// Standalone background worker for work that must outlive a Vercel request.
// It drains the optional PDF page-rendering queue and, when explicitly enabled,
// provider-specific durable AI plan-reading queues. Deploy this process only on
// a host that supports a continuously running worker (Railway/Fly/Render/VM).
import { createClient } from '@supabase/supabase-js';
import { Queue, Worker } from 'bullmq';
import { createFullTakeoffConsumerPresence, FULL_TAKEOFF_PRESENCE_INTERVAL_MS, type PresenceConsumer, type PresenceRedis } from '../apps/api/src/takeoff-v2/worker-presence.ts';
import type { DocumentDb } from '../apps/api/src/documents/service.ts';
import { PdfJobProcessor, PopplerPdfConverter, createBullMqPipeline } from '../apps/api/src/documents/worker.ts';
import {
  aiPlanQueueName,
  DurableAiPlanJobProcessor,
  type DurableAiPlanWorkerJob,
  type DurableEntitlement,
} from '../apps/api/src/ai-plan/durable.ts';
import { createGeminiClient, GeminiPlanReader, geminiSweepOptionsFromEnv } from '../apps/api/src/ai-plan/gemini.ts';
import { DurableFullTakeoffV2Processor, requeueDueFullTakeoffBudgetRuns, FULL_TAKEOFF_V2_QUEUE, FULL_TAKEOFF_V2_DURABLE_VERSION, type FullTakeoffV2WorkerJob } from '../apps/api/src/takeoff-v2/durable.ts';
import { createStageDeepPassProviderFactory } from '../apps/api/src/takeoff-v2/stage-provider.ts';
import { SqlRegionCheckpointStore } from '../apps/api/src/takeoff-v2/stage-regions.ts';
import { createLocalRegionRenderer } from '../apps/api/src/takeoff-v2/local-region-renderer.ts';
import { configureFullRunSpendLimits } from '../apps/api/src/takeoff-v2/run-spend-policy.ts';
import { createFullTakeoffRunSpendPolicy } from '../apps/api/src/takeoff-v2/paid-access.ts';
import { loadAcceptedGeometryMeasurements } from '../apps/api/src/takeoff-v2/measurement-review.ts';
import { loadPlanPageImages } from '../apps/api/src/ai-plan/page-images.ts';
import { PLAN_READING_UNAVAILABLE } from '../apps/api/src/ai-plan/readiness.ts';
import { buildConfiguredPlanReaders } from '../apps/api/src/ai-plan/readers.ts';
import { requireFreeProviderConfig } from '../apps/api/src/ai-plan/free-provider.ts';
import { MultiProviderPlanReader } from '../apps/api/src/ai-plan/multi-provider.ts';
import { assertNoPaidFallback } from '../apps/api/src/ai-plan/owner-free.ts';
import type { PlanReader, PlanReadingFindingsWriter } from '../apps/api/src/ai-plan/service.ts';
import { loadObjectStorageConfig, S3ObjectStorage } from '../apps/api/src/storage/object-storage.ts';
import { loadVercelBlobStorageConfig, VercelBlobObjectStorage } from '../apps/api/src/storage/vercel-blob-storage.ts';
import { PHOTO_TAKEOFF_VERSION, requirePhotoTakeoffConfig } from '../apps/api/src/photos/config.ts';
import { requirePhotoBridgeConfig } from '../apps/api/src/provider-bridge/photo-config.ts';
import { PhotoBridgeReader } from '../apps/api/src/provider-bridge/photo-client.ts';
import { PHOTO_TAKEOFF_QUEUE, createPhotoTakeoffQueue, type PhotoTakeoffQueue, type PhotoTakeoffJob } from '../apps/api/src/photos/queue.ts';
import { recoverCompletePhotoRuns } from '../apps/api/src/photos/complete-worker.ts';
import { HttpPhotoReader } from '../apps/api/src/photos/provider.ts';
import { PhotoTakeoffProcessor } from '../apps/api/src/photos/worker.ts';
import { loadGeometryProfile } from '../apps/api/src/geometry/config.ts';
import { createGeometryQueue, GEOMETRY_QUEUE, type GeometryJob, type GeometryQueue } from '../apps/api/src/geometry/queue.ts';
import { GeometryProcessor } from '../apps/api/src/geometry/worker.ts';
import { createAutomaticGeometryCoordinator, loadAutomaticGeometryForSheet } from '../apps/api/src/takeoff-v2/automatic-geometry.ts';
import { ProviderBridgeClient } from '../apps/api/src/provider-bridge/client.ts';
import { fullTakeoffApprovalProfile } from '../apps/api/src/takeoff-v2/user-spend-approval.ts';
import { requireBridgeRuntimeConfig } from '../apps/api/src/provider-bridge/config.ts';
import { bridgePageImages } from '../apps/api/src/provider-bridge/renderer.ts';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required to run the RoughBid background worker.`);
  return value;
}

async function buildReaders(): Promise<{
  paidReader: PlanReader;
  freeReader?: PlanReader;
  paidEnabled: boolean;
  freeEnabled: boolean;
}> {
  const paid = [];
  // A durable worker holds no HTTP request open, so its sweeps must not be cut
  // short by a request deadline: it reads every window it was authorized for.
  // The provider set is the same one the request handler builds, so a provider
  // named in AI_PLAN_PROVIDER_ORDER cannot work on one path and be missing here.
  const { ordered } = await buildConfiguredPlanReaders(process.env, { budgetMs: 0 });
  for (const reader of ordered) paid.push({ name: reader.name, read: (input: any) => reader.read(input) });

  let freeReader: PlanReader | undefined;
  try {
    const config = requireFreeProviderConfig(process.env);
    const client = await createGeminiClient(config.apiKey);
    const gemini = new GeminiPlanReader(client, [config.model], { ...geminiSweepOptionsFromEnv(process.env), budgetMs: 0 });
    assertNoPaidFallback('gemini-free-tier');
    freeReader = { read: (input: any) => gemini.read(input) };
  } catch { /* Owner-free route is allowed to remain disabled. */ }

  const paidReader: PlanReader = paid.length
    ? new MultiProviderPlanReader(paid)
    : { assertReady: () => { throw new Error(PLAN_READING_UNAVAILABLE); }, read: async () => { throw new Error(PLAN_READING_UNAVAILABLE); } };
  return {
    paidReader,
    ...(freeReader ? { freeReader } : {}),
    paidEnabled: paid.length > 0,
    freeEnabled: Boolean(freeReader),
  };
}

async function main() {
  const redisUrl = required('REDIS_URL');
  const db = createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const storage = process.env.BLOB_READ_WRITE_TOKEN
    ? new VercelBlobObjectStorage(loadVercelBlobStorageConfig(process.env))
    : new S3ObjectStorage(loadObjectStorageConfig(process.env));

  const pdfPipeline = await createBullMqPipeline(
    redisUrl,
    new PdfJobProcessor(db as unknown as DocumentDb, storage, new PopplerPdfConverter()),
  );
  console.log('[worker] pdf-processing queue attached');

  const aiWorkers: Worker[] = [];
  let fullTakeoffHeartbeat: ReturnType<typeof setInterval> | undefined;
  let fullTakeoffPresenceTimer: ReturnType<typeof setInterval> | undefined;
  let fullTakeoffPresence: ReturnType<typeof createFullTakeoffConsumerPresence> | undefined;
  let fullTakeoffPresenceQueue: Queue | undefined;
  let photoTakeoffHeartbeat: ReturnType<typeof setInterval> | undefined;
  let photoRecoveryQueue:PhotoTakeoffQueue|undefined;
  let workerHeartbeat: ReturnType<typeof setInterval> | undefined;
  let geometryHeartbeat:ReturnType<typeof setInterval>|undefined;
  let geometryQueue:GeometryQueue|undefined;
  const geometryProfile=loadGeometryProfile(process.env);
  if(geometryProfile){
    geometryQueue=await createGeometryQueue(redisUrl);
    const workerId=`${process.env.RAILWAY_REPLICA_ID||process.env.HOSTNAME||'roughbid'}-geometry-${crypto.randomUUID()}`.slice(0,160);
    const processor=new GeometryProcessor(db as unknown as DocumentDb,storage,geometryProfile,workerId,geometryQueue);
    const worker=new Worker(GEOMETRY_QUEUE,job=>processor.process(job as unknown as {data:GeometryJob}),{
      connection:{url:redisUrl,maxRetriesPerRequest:null},concurrency:1,lockDuration:30_000,stalledInterval:30_000,maxStalledCount:1});
    worker.on('failed',job=>console.error('[worker] geometry job requires reconciliation',{runId:job?.data?.runId}));
    worker.on('error',()=>console.error('[worker] geometry queue connection unavailable'));
    await worker.waitUntilReady();await processor.touch();await processor.recover();aiWorkers.push(worker);
    let geometryRecoveryRunning=false;
    geometryHeartbeat=setInterval(()=>{
      if(geometryRecoveryRunning)return;
      geometryRecoveryRunning=true;
      void processor.touch().then(()=>processor.recover()).catch(()=>console.error('[worker] geometry heartbeat or recovery unavailable'))
        .finally(()=>{geometryRecoveryRunning=false;});
    },30_000);
    console.log('[worker] geometry queue attached',{queue:GEOMETRY_QUEUE,workerId});
  }
  if (process.env.AI_PLAN_DURABLE_ENABLED === 'true') {
    const { paidReader, freeReader, paidEnabled, freeEnabled } = await buildReaders();
    if (!paidEnabled && !freeEnabled) throw new Error('AI_PLAN_DURABLE_ENABLED=true but no authorized AI provider is configured on the worker.');
    const workerId = (process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || `roughbid-${crypto.randomUUID()}`).slice(0, 160);
    const processor = new DurableAiPlanJobProcessor(
      db as unknown as PlanReadingFindingsWriter,
      storage,
      paidReader,
      freeReader,
      workerId,
    );
    const connection = { url: redisUrl, maxRetriesPerRequest: null };

    const attach = async (entitlement: DurableEntitlement) => {
      const worker = new Worker(
        aiPlanQueueName(entitlement),
        (job) => processor.process(job as unknown as DurableAiPlanWorkerJob),
        {
          connection,
          concurrency: 1,
          lockDuration: 30_000,
          stalledInterval: 30_000,
          maxStalledCount: 1,
        },
      );
      worker.on('stalled', (jobId) => console.error('[worker] ai-plan job stalled', { jobId, entitlement }));
      worker.on('failed', (job, error) => console.error('[worker] ai-plan job failed', { jobId: job?.id, entitlement, message: error.message }));
      worker.on('error', (error) => console.error('[worker] ai-plan worker error', { entitlement, message: error.message }));
      await worker.waitUntilReady();
      aiWorkers.push(worker);
      console.log('[worker] ai-plan queue attached', { queue: aiPlanQueueName(entitlement), workerId });
    };

    if (paidEnabled) await attach('paid');
    if (freeEnabled) await attach('owner_free');

    const touch = async () => {
      const result = await db.rpc('touch_ai_plan_worker', {
        p_worker_id: workerId,
        p_paid_enabled: paidEnabled,
        p_free_enabled: freeEnabled,
      });
      if (result.error) console.error('[worker] ai-plan heartbeat failed', { message: result.error.message });
    };
    await touch();
    workerHeartbeat = setInterval(() => { void touch(); }, 30_000);
    console.log('[worker] ai-plan heartbeat active', { workerId, paidEnabled, freeEnabled });
  }

  if (process.env.TAKEOFF_V2_ENABLED === 'true' && process.env.TAKEOFF_V2_WORKER_ENABLED === 'true') {
    // Validate exact capabilities before advertising a consumer. Spending
    // authority is validated per run, before its budget is persisted.
    const rpc = async (name: string, args: Record<string, unknown>) => await db.rpc(name, args);
    const workerId = crypto.randomUUID();
    const bridge = process.env.TAKEOFF_V2_TRANSPORT === 'bridge'
      ? new ProviderBridgeClient(db, requireBridgeRuntimeConfig(process.env, 'worker'), workerId, crypto.randomUUID()) : undefined;
    // Key parity, real endpoint, schema and exact profile are proven without inference.
    // A configured bridge failure never falls back to local provider credentials.
    if (bridge) await bridge.handshake();
    const runSpendPolicy = createFullTakeoffRunSpendPolicy(process.env);
    // Nonsecret diagnostics distinguish stale consent from a failed budget RPC.
    // Never log environment values, signed URLs, or exception messages.
    let approvalPolicyId: string | undefined;
    try { approvalPolicyId = fullTakeoffApprovalProfile(process.env).policyId; } catch { /* Paid-only workers need no complimentary profile. */ }
    const schema = await db.rpc('full_takeoff_stage_schema_ready');
    if (schema.error || schema.data !== true) throw new Error('Full Takeoff regional/measurement/budget schema has not been reviewed and activated.');
    const renderRegion = createLocalRegionRenderer(process.env);
    const factory = createStageDeepPassProviderFactory(process.env, fetch, {
      ...(bridge ? { evidenceTransport: bridge.evidenceTransport } : {}),
      async prepareRun(input){
        let limits;
        try { limits = runSpendPolicy(input.manifest); }
        catch {
          console.error('[worker] Full Takeoff setup rejected', { phase: 'spending_profile',
            complimentaryProfileAvailable: Boolean(approvalPolicyId),
            savedProfileMatches: input.manifest.spendApproval?.policyId === approvalPolicyId });
          throw new Error('Full Takeoff spending profile validation failed.');
        }
        try { await configureFullRunSpendLimits(input,limits,rpc); }
        catch {
          console.error('[worker] Full Takeoff setup rejected', { phase: 'budget_persistence' });
          throw new Error('Full Takeoff budget persistence failed.');
        }
        if(geometryProfile?.kamai&&geometryQueue){
          const actor=await db.from('takeoff_runs').select('requested_by').eq('id',input.runId).eq('workspace_id',input.workspaceId)
            .eq('project_id',input.projectId).eq('file_id',input.fileId).maybeSingle();
          if(actor.error||!actor.data?.requested_by)throw new Error('Automatic geometry parent ownership could not be verified.');
          const coordinator=createAutomaticGeometryCoordinator(db as unknown as DocumentDb,{writer:db as unknown as DocumentDb,storage,profile:geometryProfile,queue:geometryQueue});
          const result=await coordinator.prepare({...input,userId:actor.data.requested_by});
          if(result.state!=='reserved')console.error('[worker] some automatic geometry pages remain pending',{runId:input.runId});
        }
      },
      regionCheckpoints: new SqlRegionCheckpointStore(rpc),
      ...(renderRegion ? { renderRegion } : {}),
      async loadPriorEvidence(input) {
        const stored = await db.from('takeoff_passes').select('status,checkpoint,provider,model')
          .eq('takeoff_run_id', input.runId).eq('workspace_id', input.workspaceId).eq('project_id', input.projectId)
          .in('pass_type', ['classification', 'legends_schedules']).in('status', ['succeeded','blocked']).limit(400);
        if (stored.error) throw new Error('Saved source inventory could not be recovered.');
        return (stored.data ?? []).map(value => ({ status: value.status as 'succeeded' | 'blocked', checkpoint: value.checkpoint,
          ...(value.provider ? { provider: value.provider } : {}), ...(value.model ? { model: value.model } : {}) }));
      },
      async loadGeometryMeasurements(input, request) {
        const reviewed=await loadAcceptedGeometryMeasurements(db, { runId: input.runId, workspaceId: input.workspaceId,
          projectId: input.projectId, fileId: input.fileId, fileSha256: input.manifest.fileSha256,
          physicalPageNumber: request.sheet.physicalPageNumber, pageSha256: request.sheet.pageSha256 });
        const automatic=geometryProfile?await loadAutomaticGeometryForSheet(db as unknown as DocumentDb,{workspaceId:input.workspaceId,projectId:input.projectId,
          fileId:input.fileId,fileSha256:input.manifest.fileSha256,physicalPageNumber:request.sheet.physicalPageNumber}):{coverage:'automatic_geometry_disabled',candidates:[]};
        return {...reviewed,automatic_geometry:automatic};
      },
      async loadPageImages(input, page) {
        if(bridge)return bridgePageImages(input.fileBytes,input.manifest,page,Number(process.env.TAKEOFF_V2_REGION_GRID??2) as 2|3);
        const prefix = `${input.workspaceId}/${input.projectId}/${input.fileId}/pages/`;
        const images = await loadPlanPageImages({ db, fileId: input.fileId, pageNumbers: [page], maxImages: 1,
          storage: { async presign(method, key, options) {
            if (!key.startsWith(prefix) || key.includes('..')) throw new Error('Full Takeoff page asset is outside the authorized file.');
            return storage.presign(method, key, options);
          } } });
        return images.map(image => ({ dataUrl: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString('base64')}`,
          label: `Physical page ${image.pageNumber}`, pageNumber: image.pageNumber }));
      },
    });
    const processor = new DurableFullTakeoffV2Processor(db as unknown as PlanReadingFindingsWriter,
      storage, factory, workerId);
    const touch = async () => {
      if (bridge) await bridge.handshake();
      const touched = await db.rpc('touch_full_takeoff_v2_worker', { p_worker_id: workerId, p_version: FULL_TAKEOFF_V2_DURABLE_VERSION });
      if (touched.error || touched.data !== true) throw new Error('Full Takeoff V2 schema/capability heartbeat is unavailable.');
    };
    // Fail before attaching a consumer if the reviewed migration is missing.
    await touch();
    const worker = new Worker(FULL_TAKEOFF_V2_QUEUE, job => processor.process(job as unknown as FullTakeoffV2WorkerJob), {
      connection: { url: redisUrl, maxRetriesPerRequest: null }, concurrency: 1,
      lockDuration: 30_000, stalledInterval: 30_000, maxStalledCount: 1,
    });
    worker.on('failed', job => console.error('[worker] Full Takeoff V2 stopped', { runId: job?.data?.runId }));
    worker.on('error', () => console.error('[worker] Full Takeoff V2 queue connection failed'));
    await worker.waitUntilReady();
    aiWorkers.push(worker);
    fullTakeoffPresenceQueue = new Queue(FULL_TAKEOFF_V2_QUEUE, { skipMetasUpdate: true, connection: {
      url: redisUrl, maxRetriesPerRequest: 1, enableOfflineQueue: false, autoResendUnfulfilledCommands: false,
      connectTimeout: 5000, commandTimeout: 5000,
    } });
    fullTakeoffPresenceQueue.on('error', () => console.error('[worker] Full Takeoff V2 presence connection unavailable'));
    fullTakeoffPresence = createFullTakeoffConsumerPresence(worker as unknown as PresenceConsumer, workerId,
      fullTakeoffPresenceQueue.client as unknown as Promise<PresenceRedis>);
    let recoveringBudget = false;
    const refreshPresence = async () => {
      if (!await fullTakeoffPresence!.refresh()) { console.error('[worker] Full Takeoff V2 consumer presence unavailable'); return; }
      if (recoveringBudget) return;
      recoveringBudget = true;
      try {
        await requeueDueFullTakeoffBudgetRuns(db as unknown as PlanReadingFindingsWriter, {add: runId =>
          fullTakeoffPresenceQueue!.add('full-takeoff',{runId},{jobId:runId,attempts:3,
            backoff:{type:'exponential',delay:5000},removeOnComplete:true,removeOnFail:true})});
      } catch { console.error('[worker] Full Takeoff V2 saved waiting readings will retry queue recovery'); }
      finally { recoveringBudget = false; }
    };
    await refreshPresence();
    fullTakeoffPresenceTimer = setInterval(() => { void refreshPresence(); }, FULL_TAKEOFF_PRESENCE_INTERVAL_MS);
    fullTakeoffHeartbeat = setInterval(() => { void touch().catch(() => console.error('[worker] Full Takeoff V2 heartbeat unavailable')); }, 30_000);
    console.log('[worker] Full Takeoff V2 queue attached', { queue: FULL_TAKEOFF_V2_QUEUE, workerId });
  }

  if (process.env.PHOTO_TAKEOFF_ENABLED === 'true' && process.env.PHOTO_TAKEOFF_WORKER_ENABLED === 'true') {
    // Photos use their own private-data approval, verified maximum-quality
    // profile and spend authorization. A provider balance never opens this path.
    const workerId = crypto.randomUUID();
    const photoBridgeConfig=process.env.PHOTO_TAKEOFF_TRANSPORT==='bridge'?requirePhotoBridgeConfig(process.env,'worker'):undefined;
    const config=photoBridgeConfig?.profile??requirePhotoTakeoffConfig(process.env);
    const photoBridge=photoBridgeConfig?new PhotoBridgeReader(db,photoBridgeConfig,workerId,crypto.randomUUID()):undefined;
    if(photoBridge)await photoBridge.handshake();
    const processor = new PhotoTakeoffProcessor(db as unknown as DocumentDb, storage,
      photoBridge??new HttpPhotoReader(requirePhotoTakeoffConfig(process.env)), config, workerId);
    await processor.touch();
    const worker = new Worker(PHOTO_TAKEOFF_QUEUE, job => processor.process(job as unknown as { data: PhotoTakeoffJob }), {
      connection: { url: redisUrl, maxRetriesPerRequest: null }, concurrency: 1,
      lockDuration: 30_000, stalledInterval: 30_000, maxStalledCount: 1,
    });
    worker.on('failed', job => console.error('[worker] photo takeoff stopped', { runId: job?.data?.runId }));
    worker.on('error', () => console.error('[worker] photo takeoff queue connection failed'));
    await worker.waitUntilReady();
    aiWorkers.push(worker);
    photoRecoveryQueue = await createPhotoTakeoffQueue(redisUrl);
    let recoveringPhotos=false;
    const recoverPhotos=async()=>{
      if(recoveringPhotos||!photoRecoveryQueue)return;
      recoveringPhotos=true;
      try{if(photoBridge)await photoBridge.handshake();await processor.touch();await recoverCompletePhotoRuns(db as unknown as DocumentDb,photoRecoveryQueue,config);}
      finally{recoveringPhotos=false;}
    };
    await recoverPhotos();
    photoTakeoffHeartbeat = setInterval(() => {
      void recoverPhotos().catch(() => console.error('[worker] photo takeoff heartbeat or saved reading recovery unavailable'));
    }, 30_000);
    console.log('[worker] photo takeoff queue attached', { queue: PHOTO_TAKEOFF_QUEUE, version: PHOTO_TAKEOFF_VERSION, workerId });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] received ${signal}, shutting down`);
    if (workerHeartbeat) clearInterval(workerHeartbeat);
    if (fullTakeoffHeartbeat) clearInterval(fullTakeoffHeartbeat);
    if (fullTakeoffPresenceTimer) clearInterval(fullTakeoffPresenceTimer);
    if (photoTakeoffHeartbeat) clearInterval(photoTakeoffHeartbeat);
    if (geometryHeartbeat) clearInterval(geometryHeartbeat);
    await fullTakeoffPresence?.close();
    await fullTakeoffPresenceQueue?.close().catch(() => console.error('[worker] Full Takeoff V2 presence connection close unavailable'));
    await Promise.allSettled([
      (pdfPipeline.worker as { close?: () => Promise<void> }).close?.(),
      ...aiWorkers.map((worker) => worker.close()),
      geometryQueue?.close?.(),
      photoRecoveryQueue?.close?.(),
    ]);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(() => {
  console.error('[worker] startup configuration or required dependency unavailable');
  process.exit(1);
});
