// Standalone background worker: drains the pdf-processing BullMQ queue,
// rendering uploaded plan PDFs to page images for the in-app blueprint
// viewer. Run this as a long-lived process on a host that can stay up
// (Vercel functions cannot) — e.g. `npm run worker` on a small always-on box,
// Railway, Fly.io, or a Render worker service — alongside the deployed API.
//
// AI plan reading does NOT run here: it reads the uploaded PDF directly and
// synchronously inline in the API request (see apps/api/src/ai-plan/service.ts
// and gemini.ts) — an earlier async, BullMQ-queued design needed exactly this
// kind of separately-deployed worker and never actually got one running in
// production, so the synchronous approach is what ships.
import { createClient } from '@supabase/supabase-js';
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

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] received ${signal}, shutting down`);
    const closeable = pdfPipeline.worker as { close?: () => Promise<void> };
    await closeable.close?.();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[worker] fatal startup error', error);
  process.exit(1);
});
