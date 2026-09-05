// Standalone background worker: drains the pdf-processing and ai-plan-reading
// BullMQ queues. Run this as a long-lived process on a host that can stay up
// (Vercel functions cannot) — e.g. `npm run worker` on a small always-on box,
// Railway, Fly.io, or a Render worker service — alongside the deployed API.
import { createClient } from '@supabase/supabase-js';
import { OpenAiPlanReader } from '../apps/api/src/ai-plan/openai.ts';
import { AiPlanReadingJobProcessor, createAiPlanWorker, type AiPlanWorkerDb } from '../apps/api/src/ai-plan/worker.ts';
import type { DocumentDb } from '../apps/api/src/documents/service.ts';
import { PdfJobProcessor, PopplerPdfConverter, createBullMqPipeline } from '../apps/api/src/documents/worker.ts';
import { loadObjectStorageConfig, S3ObjectStorage } from '../apps/api/src/storage/object-storage.ts';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required to run the RoughBid background worker.`);
  return value;
}

async function main() {
  const redisUrl = required('REDIS_URL');
  const db = createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const storage = new S3ObjectStorage(loadObjectStorageConfig(process.env));

  const pdfPipeline = await createBullMqPipeline(
    redisUrl,
    new PdfJobProcessor(db as unknown as DocumentDb, storage, new PopplerPdfConverter()),
  );
  console.log('[worker] pdf-processing queue attached');

  let aiPlanWorker: { close?: () => Promise<void> } | null = null;
  const openAiApiKey = process.env.OPENAI_API_KEY?.trim();
  if (openAiApiKey) {
    const reader = new OpenAiPlanReader(openAiApiKey, process.env.OPENAI_MODEL?.trim() || 'gpt-4.1');
    aiPlanWorker = (await createAiPlanWorker(
      redisUrl,
      new AiPlanReadingJobProcessor(db as unknown as AiPlanWorkerDb, storage, reader),
    )) as { close?: () => Promise<void> };
    console.log('[worker] ai-plan-reading queue attached');
  } else {
    console.warn('[worker] OPENAI_API_KEY is not set — plan reading jobs will stay queued until it is.');
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] received ${signal}, shutting down`);
    const closeable = pdfPipeline.worker as { close?: () => Promise<void> };
    await Promise.all([closeable.close?.(), aiPlanWorker?.close?.()]);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[worker] fatal startup error', error);
  process.exit(1);
});
