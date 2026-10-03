// Read-only Redis inspection: no queues are constructed, jobs consumed, or
// provider methods imported. It never prints endpoint credentials or job data.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import Redis from 'ioredis';

const env = {};
for (const file of process.argv.slice(2)) Object.assign(env, parseEnv(readFileSync(file, 'utf8')));
if (!env.REDIS_URL) throw new Error('REDIS_URL is not configured');
const endpoint = new URL(env.REDIS_URL);
if (!['redis:', 'rediss:'].includes(endpoint.protocol)) throw new Error('Unsupported Redis URL scheme');
const client = new Redis(env.REDIS_URL, { lazyConnect: true, connectTimeout: 8000, commandTimeout: 8000,
  maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null });
client.on('error', () => {});
const result = { checkedAt: new Date().toISOString(), tls: endpoint.protocol === 'rediss:',
  credentialPresent: Boolean(endpoint.password), authenticated: false, readOnly: true, queues: {} };
const queues = ['pdf-processing', 'ai-plan-reading-paid', 'ai-plan-reading-owner-free', 'takeoff-full-v2', 'roughbid-photo-takeoff', 'roughbid-geometry-provider'];
const errorCode = error => /NOPERM|NOAUTH|WRONGPASS|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|CERT_[A-Z_]+/.exec(String(error?.message))?.[0] || 'unavailable';
try {
  await client.connect();
  result.authenticated = await client.ping() === 'PONG';
  if (endpoint.protocol === 'rediss:') result.tlsCertificateAuthorized = client.connector.stream?.authorized === true;
  for (const queue of queues) {
    const counts = {};
    for (const state of ['wait', 'active', 'paused']) counts[state] = await client.llen(`bull:${queue}:${state}`);
    for (const state of ['delayed', 'prioritized', 'waiting-children', 'failed', 'completed']) counts[state] = await client.zcard(`bull:${queue}:${state}`);
    result.queues[queue] = { counts };
  }
  try {
    const clients = await client.client('LIST');
    for (const queue of queues) {
      const expected = `bull:${Buffer.from(queue).toString('base64')}`;
      result.queues[queue].consumers = clients.split('\n').filter(line => {
        const name = /(?:^| )name=([^ ]*)/.exec(line)?.[1];
        return name === expected || name?.startsWith(`${expected}:`);
      }).length;
    }
    result.consumerListing = 'available';
  } catch (error) { result.consumerListing = errorCode(error); }
  try {
    const who = await client.acl('WHOAMI');
    result.aclIdentityVerified = Boolean(who);
    result.aclDryRun = {};
    for (const [command, args] of [['EVAL', ['return 1', '0']], ['CLIENT', ['LIST']], ['HSET', ['bull:roughbid-control-probe:dryrun', 'field', 'value']], ['LPUSH', ['bull:roughbid-control-probe:dryrun', 'value']]]) {
      try { result.aclDryRun[command] = await client.acl('DRYRUN', who, command, ...args) === 'OK'; }
      catch (error) { result.aclDryRun[command] = errorCode(error); }
    }
  } catch (error) { result.aclIdentityVerified = false; result.aclInspection = errorCode(error); }
  try {
    const info = await client.info('server');
    result.redisVersion = /^redis_version:(.*)$/m.exec(info)?.[1]?.trim() || 'not_reported';
  } catch (error) { result.redisVersion = errorCode(error); }
} catch (error) { result.connectionError = errorCode(error); process.exitCode = 1; }
finally { client.disconnect(); }
console.log(JSON.stringify(result, null, 2));
