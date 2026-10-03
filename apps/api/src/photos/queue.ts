import { PHOTO_TAKEOFF_VERSION } from './config.ts';

export const PHOTO_TAKEOFF_QUEUE = 'roughbid-photo-takeoff';
export interface PhotoTakeoffJob { runId: string; version: typeof PHOTO_TAKEOFF_VERSION }
export interface PhotoTakeoffQueue {
  add(name: 'read-photos', data: PhotoTakeoffJob, options: { jobId: string; attempts: 1; removeOnComplete: number; removeOnFail: number }): Promise<unknown>;
  close?(): Promise<void>;
  on?(event: string, listener: () => void): unknown;
}
export async function createPhotoTakeoffQueue(redisUrl: string, loader: () => Promise<{ Queue: new (name: string, options: any) => PhotoTakeoffQueue }>
  = () => import('bullmq') as any): Promise<PhotoTakeoffQueue> {
  if (!redisUrl) throw new Error('Photo takeoff requires REDIS_URL.');
  const bull = await loader();
  const queue = new bull.Queue(PHOTO_TAKEOFF_QUEUE, { connection: { url: redisUrl, maxRetriesPerRequest: 1,
    enableOfflineQueue: false, connectTimeout: 5_000, retryStrategy: () => null } });
  queue.on?.('error', () => {});
  return queue;
}
export async function enqueuePhotoRun(queue: PhotoTakeoffQueue, runId: string): Promise<void> {
  // A lost queue acknowledgement can be reconciled by resume; paid retries are never automatic.
  await queue.add('read-photos', { runId, version: PHOTO_TAKEOFF_VERSION }, { jobId: `${runId}-${crypto.randomUUID()}`,
    attempts: 1, removeOnComplete: 1000, removeOnFail: 1000 });
}
