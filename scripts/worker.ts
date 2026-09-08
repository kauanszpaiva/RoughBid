// Standalone background worker for work that must outlive a Vercel request.
// It drains the optional PDF page-rendering queue and, when explicitly enabled,
// provider-specific durable AI plan-reading queues. Deploy this process only on
// a host that supports a continuously running worker (Railway/Fly/Render/VM).
import { createClient } from '@supabase/supabase-js';
import { Worker } from 'bullmq';
import type { DocumentDb } from '../apps/api/src/documents/service.ts';
import { PdfJobProcessor, PopplerPdfConverter, createBullMqPipeline } from '../apps/api/src/documents/worker.ts';
import {
  aiPlanQueueName,
  DurableAiPlanJobProcessor,
  type DurableAiPlanWorkerJob,
  type DurableEntitlement,
} from '../apps/api/src/ai-plan/durable.ts';
import { createGeminiClient, GeminiPlanReader } from '../apps/api/src/ai-plan/gemini.ts';
import { requirePaidPlanReadingConfig, PLAN_READING_UNAVAILABLE } from '../apps/api/src/ai-plan/readiness.ts';
import { requireFreeProviderConfig } from '../apps/api/src/ai-plan/free-provider.ts';
import { MultiProviderPlanReader } from '../apps/api/src/ai-plan/multi-provider.ts';
import { assertNoPaidFallback } from '../apps/api/src/ai-plan/owner-free.ts';
import type { PlanReader, PlanReadingFindingsWriter } from '../apps/api/src/ai-plan/service.ts';
import { loadObjectStorageConfig, S3ObjectStorage } from '../apps/api/src/storage/object-storage.ts';
import { loadVercelBlobStorageConfig, VercelBlobObjectStorage } from '../apps/api/src/storage/vercel-blob-storage.ts';

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
  try {
    const config = requirePaidPlanReadingConfig(process.env);
    const client = await createGeminiClient(config.apiKey);
    const gemini = new GeminiPlanReader(client, [config.model]);
    paid.push({ name: 'gemini', read: (input: any) => gemini.read(input) });
  } catch { /* Paid provider is allowed to remain disabled. */ }

  let freeReader: PlanReader | undefined;
  try {
    const config = requireFreeProviderConfig(process.env);
    const client = await createGeminiClient(config.apiKey);
    const gemini = new GeminiPlanReader(client, [config.model]);
    assertNoPaidFallback('gemini-free-tier');
    freeReader = { read: (input: any) => gemini.read(input) };
  } catch { /* Owner-free route is allowed to remain disabled. */ }

  const paidReader: PlanReader = paid.length
    ? new MultiProviderPlanReader(paid)
    : { assertReady: () => { throw new Error(PLAN_READING_UNAVAILABLE); }, read: async () => { throw new Error(PLAN_READING_UNAVAILABLE); } };
  return {
    paidReader,
    freeReader,
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
  let workerHeartbeat: ReturnType<typeof setInterval> | undefined;
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

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] received ${signal}, shutting down`);
    if (workerHeartbeat) clearInterval(workerHeartbeat);
    await Promise.allSettled([
      (pdfPipeline.worker as { close?: () => Promise<void> }).close?.(),
      ...aiWorkers.map((worker) => worker.close()),
    ]);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[worker] fatal startup error', error);
  process.exit(1);
});
