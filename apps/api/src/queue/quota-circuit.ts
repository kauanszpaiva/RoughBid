/** Process-local latch. It never resumes queues or changes job/checkpoint data. */
export function isUpstashQuotaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { name?: unknown; message?: unknown };
  return value.name === 'ReplyError' && typeof value.message === 'string'
    && /^(?:ERR )?max requests limit exceeded\. Limit: \d+, Usage: \d+(?:[.\s]|$)/.test(value.message);
}
export interface QuotaWorker {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  pause(doNotWaitActive?: boolean): Promise<void>;
}
export function createQuotaCircuit(log: () => void = () => {
  console.error('[worker] Redis monthly quota exhausted; new queue fetching paused; readiness degraded; manual recovery and in-flight reconciliation required');
}) {
  let tripped = false;
  const workers = new Set<QuotaWorker>();
  const stopped = new Set<QuotaWorker>();
  const stops = new Set<() => void>();
  const stopWorker = (worker: QuotaWorker) => {
    if (stopped.has(worker)) return;
    stopped.add(worker);
    // Local pause stops fetch/stalled-check loops without a Redis write.
    // Do not force-close an initializing BullMQ RedisConnection: v5.81.4 can
    // emit an unhandled rejection after removing its initialization listeners.
    // Already-active work retains its normal lock/settlement lifecycle.
    try { void worker.pause(true).catch(() => {}); } catch { /* Latch remains shut. */ }
  };
  const observe = (error: unknown): boolean => {
    if (!isUpstashQuotaError(error)) return false;
    if (tripped) return true;
    tripped = true;
    for (const stop of stops) { try { stop(); } catch { /* Best effort; no retry. */ } }
    stops.clear();
    for (const worker of workers) stopWorker(worker);
    log();
    return true;
  };
  const onTrip = (stop: () => void) => {
    if (tripped) { try { stop(); } catch { /* No retry. */ } }
    else stops.add(stop);
  };
  return {
    get tripped() { return tripped; },
    observe,
    onTrip,
    registerWorker(worker: QuotaWorker) {
      if (workers.has(worker)) return;
      workers.add(worker);
      worker.on('error', observe);
      if (tripped) stopWorker(worker);
    },
    assertOpen() {
      if (tripped) throw new Error('Redis quota circuit open: manual recovery required');
    },
    interval(callback: () => void, delay: number) {
      if (tripped) return undefined;
      const timer = setInterval(() => { if (!tripped) callback(); }, delay);
      onTrip(() => clearInterval(timer));
      return timer;
    },
  };
}
export type QuotaCircuit = ReturnType<typeof createQuotaCircuit>;
