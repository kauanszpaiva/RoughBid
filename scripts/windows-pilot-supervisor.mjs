import { fork } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseEnv } from 'node:util';

const configPath = resolve(process.argv[2] || '');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const stateDirectory = resolve(config.stateDirectory);
mkdirSync(stateDirectory, { recursive: true });
const enabledPath = join(stateDirectory, 'enabled');
const lockPath = join(stateDirectory, 'supervisor.lock');
const stopPath = join(stateDirectory, 'stop-request');
const statusPath = join(stateDirectory, 'status.json');
const logPath = join(stateDirectory, 'worker.log');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
if (!existsSync(enabledPath)) process.exit(0);
if (existsSync(lockPath)) {
  let prior;
  try { prior = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { /* fail closed below */ }
  if (!prior || alive(prior.pid)) process.exit(0);
  unlinkSync(lockPath);
}
try { writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' }); }
catch { process.exit(0); }
if (existsSync(stopPath)) unlinkSync(stopPath);
let child, stopping = false, restartTimer, restarts = 0, restartDelay = 5000, secrets = [];
const status = { supervisorPid: process.pid, childPid: null, startedAt: new Date().toISOString(), heartbeatAt: null,
  state: 'starting', restarts: 0, queues: [], liveTestsEnabled: false, liveTestSpendApproved: false };
const scrub = value => {
  let safe = String(value);
  for (const secret of secrets) safe = safe.split(secret).join('[REDACTED]');
  return safe.replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(rediss?:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b(?:sk-|sb_secret_|vercel_blob_rw_)[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 8192);
};
function log(message) {
  if (existsSync(logPath) && statSync(logPath).size > 2 * 1024 * 1024) {
    const prior = `${logPath}.previous`;
    if (existsSync(prior)) unlinkSync(prior);
    renameSync(logPath, prior);
  }
  appendFileSync(logPath, `${new Date().toISOString()} ${scrub(message)}\n`);
}
function publish() {
  status.heartbeatAt = new Date().toISOString();
  const temp = `${statusPath}.tmp`;
  writeFileSync(temp, JSON.stringify(status, null, 2));
  renameSync(temp, statusPath);
}
function release() {
  clearInterval(pulse);
  if (restartTimer) clearTimeout(restartTimer);
  status.state = 'stopped'; status.childPid = null; publish();
  try {
    if (JSON.parse(readFileSync(lockPath, 'utf8')).pid === process.pid) unlinkSync(lockPath);
  } catch { /* never delete a different supervisor's lock */ }
  process.exit(0);
}
function requestStop() {
  if (stopping) return;
  stopping = true; status.state = 'draining'; publish();
  log('[supervisor] graceful stop requested; active jobs may finish before exit');
  if (restartTimer) clearTimeout(restartTimer);
  if (child?.connected) child.send({ type: 'roughbid:stop' });
  else if (!child) release();
}
function start() {
  if (stopping || !existsSync(enabledPath)) return requestStop();
  try {
    const loaded = {};
    for (const envFile of config.envFiles) Object.assign(loaded, parseEnv(readFileSync(envFile, 'utf8')));
    // Sensitive Vercel variables are intentionally not exportable. A masked
    // placeholder must never reach an SDK as if it were a real credential.
    for (const [key, value] of Object.entries(loaded)) if (value.includes('[SENSITIVE]')) delete loaded[key];
    if (loaded.ROUGH_BID_PILOT_PROFILE_VALID_UNTIL &&
        (!Number.isFinite(Date.parse(loaded.ROUGH_BID_PILOT_PROFILE_VALID_UNTIL)) || Date.now() >= Date.parse(loaded.ROUGH_BID_PILOT_PROFILE_VALID_UNTIL))) {
      throw new Error('Reviewed pilot pricing profile has expired; provider processing stays closed');
    }
    for (const key of ['REDIS_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
      if (!loaded[key]?.trim() || loaded[key].includes('[SENSITIVE]')) throw new Error(`Missing or masked worker configuration: ${key}`);
    }
    if (new URL(loaded.SUPABASE_URL).hostname !== config.supabaseHost) throw new Error('Supabase target differs from the reviewed pilot project');
    loaded.ROUGH_BID_LIVE_TESTS_ENABLED = 'false';
    loaded.ROUGH_BID_LIVE_TEST_SPEND_APPROVED = 'false';
    secrets = Object.entries(loaded).filter(([key, value]) => /KEY|TOKEN|PASSWORD|SECRET|URL|DSN/.test(key) && value.length > 5)
      .map(([, value]) => value).sort((a, b) => b.length - a.length);
    try { const redis = new URL(loaded.REDIS_URL); if (redis.password) secrets.push(redis.password, decodeURIComponent(redis.password)); } catch {}
    const childEnv = { ...process.env, ...loaded, PATH: `${config.popplerDirectory};${dirname(config.nodePath)};${process.env.PATH || ''}` };
    delete childEnv.NODE_OPTIONS;
    status.state = 'starting'; status.queues = []; publish();
    child = fork(join(config.repository, 'scripts', 'windows-pilot-bootstrap.mjs'), [], {
      cwd: config.repository, execPath: config.nodePath, execArgv: ['--experimental-strip-types'],
      env: childEnv, silent: true, windowsHide: true,
    });
    status.childPid = child.pid; status.state = 'running'; publish();
    const started = Date.now();
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', line => {
        log(line);
        const match = line.match(/\[worker\] ([A-Za-z0-9 -]+) queue attached/);
        if (match && !status.queues.includes(match[1])) { status.queues.push(match[1]); publish(); }
      });
    }
    child.once('error', () => log('[supervisor] worker process launch failed'));
    child.once('exit', (code, signal) => {
      log(`[supervisor] worker exited code=${code} signal=${signal || 'none'}`);
      child = undefined; status.childPid = null;
      if (stopping) return release();
      restarts += 1; status.restarts = restarts; status.state = 'restarting'; publish();
      restartDelay = Date.now() - started > 60_000 ? 5000 : Math.min(restartDelay * 2, 60_000);
      restartTimer = setTimeout(start, restartDelay);
    });
    log('[supervisor] worker process started; provider readiness is reported separately');
  } catch (error) {
    status.state = 'configuration_error'; status.childPid = null; publish();
    log(`[supervisor] ${error instanceof Error ? error.message : 'configuration unavailable'}`);
    restartTimer = setTimeout(start, 60_000);
  }
}
const pulse = setInterval(() => {
  publish();
  if (existsSync(stopPath) || !existsSync(enabledPath)) requestStop();
}, 5000);
process.on('SIGINT', requestStop);
process.on('SIGTERM', requestStop);
process.on('exit', () => { if (child?.connected) child.send({ type: 'roughbid:stop' }); });
start();
