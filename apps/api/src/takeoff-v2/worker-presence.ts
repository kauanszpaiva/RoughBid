// Consumer presence is independent of CLIENT LIST, whose connection snapshots
// can omit live workers on managed Redis. SQL capability checks remain required.
export const FULL_TAKEOFF_PRESENCE_KEY = 'roughbid:consumer-presence:takeoff-full-v2:takeoff-v2.2-durable';
export const FULL_TAKEOFF_PRESENCE_TTL_MS = 45_000;
export const FULL_TAKEOFF_PRESENCE_INTERVAL_MS = 15_000;
export interface PresenceRedis {
  status: string;
  eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>;
  zrem(key: string, member: string): Promise<unknown>;
}
export interface PresenceConsumer {
  isRunning(): boolean;
  isPaused(): boolean;
  closing?: unknown;
  closed?: boolean;
  client: PromiseLike<{ status: string }>;
  blockingConnection: { client: PromiseLike<{ status: string }> };
}
export const RENEW_FULL_TAKEOFF_PRESENCE = `
local time = redis.call('TIME')
local now = tonumber(time[1])*1000 + math.floor(tonumber(time[2])/1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
return 1`;
export const READ_FULL_TAKEOFF_PRESENCE = `
local kind = redis.call('TYPE', KEYS[1])
if kind.ok ~= 'zset' then return 0 end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 or ttl > tonumber(ARGV[1]) then return 0 end
local time = redis.call('TIME')
local now = tonumber(time[1])*1000 + math.floor(tonumber(time[2])/1000)
return redis.call('ZCOUNT', KEYS[1], '(' .. now, now + tonumber(ARGV[1]))`;

async function bounded<T>(value: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.resolve(value), new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Consumer connection check timed out')), 5000);
  })]); } finally { if (timer) clearTimeout(timer); }
}
export async function fullTakeoffConsumerPresent(client: PromiseLike<PresenceRedis>): Promise<boolean> {
  try {
    const redis = await bounded(client);
    if (redis.status !== 'ready') return false;
    const count = await bounded(redis.eval(READ_FULL_TAKEOFF_PRESENCE, 1, FULL_TAKEOFF_PRESENCE_KEY, FULL_TAKEOFF_PRESENCE_TTL_MS));
    return typeof count === 'number' && Number.isSafeInteger(count) && count > 0;
  } catch { return false; }
}
/** Dedicated lease connection must have commandTimeout and offline queue disabled. */
export function createFullTakeoffConsumerPresence(consumer: PresenceConsumer, workerId: string,
  leaseClient: PromiseLike<PresenceRedis>) {
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(workerId)) throw new Error('Invalid worker presence identity');
  let stopping = false;
  let pending: Promise<boolean> | undefined;
  const running = () => !stopping && consumer.isRunning() && !consumer.isPaused() && !consumer.closing && !consumer.closed;
  const revoke = async () => {
    try { const client = await bounded(leaseClient); if (client.status === 'ready') await bounded(client.zrem(FULL_TAKEOFF_PRESENCE_KEY, workerId)); }
    catch { /* Its server-side expiry remains the fail-closed fallback. */ }
  };
  const refresh = (): Promise<boolean> => {
    if (stopping) return Promise.resolve(false);
    if (pending) return pending;
    pending = (async () => {
      try {
        if (!running()) { await revoke(); return false; }
        const [primary, blocking, lease] = await bounded(Promise.all([consumer.client, consumer.blockingConnection.client, leaseClient]));
        // RedisConnection.status alone can remain ready during a reconnect;
        // these are the actual underlying client statuses on both connections.
        if (!running() || primary.status !== 'ready' || blocking.status !== 'ready' || lease.status !== 'ready') {
          await revoke(); return false;
        }
        const result = await lease.eval(RENEW_FULL_TAKEOFF_PRESENCE, 1, FULL_TAKEOFF_PRESENCE_KEY, workerId, FULL_TAKEOFF_PRESENCE_TTL_MS);
        if (!running() || primary.status !== 'ready' || blocking.status !== 'ready') { await revoke(); return false; }
        return result === 1;
      } catch { await revoke(); return false; }
      finally { pending = undefined; }
    })();
    return pending;
  };
  return {
    refresh,
    async close() {
      stopping = true;
      // Publication and final removal are ordered: a delayed renewal cannot
      // resurrect this worker after shutdown, or delete another worker's member.
      if (pending) await pending;
      await revoke();
    },
  };
}
