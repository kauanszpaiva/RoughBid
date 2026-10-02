import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApsModelDerivativeAdapter, ApsProviderError, inspectApsManifest, requireApsProviderConfig,
  type ApsProviderConfig, type ApsCheckpointStore, type ApsTranslationCheckpoint,
} from '../src/takeoff-v2/aps-provider.ts';

const config: ApsProviderConfig = { clientId: 'aps-unit-client', clientSecret: 'aps-unit-secret',
  enabled: true, integrationApproved: true, dataAuthorized: true };
const input = { runId: 'run-1', sourceFormat: 'rvt', objectId: 'urn:adsk.objects:os.object:mock-bucket/synthetic.rvt' };
const sourceUrn = Buffer.from(input.objectId).toString('base64url');
const epoch = Date.parse('2026-10-02T12:00:00Z');
class MemoryStore implements ApsCheckpointStore {
  rows = new Map<string, ApsTranslationCheckpoint>();
  async load(runId: string) { return structuredClone(this.rows.get(runId) ?? null); }
  async claimInitial(checkpoint: ApsTranslationCheckpoint) {
    if (this.rows.has(checkpoint.runId)) return false;
    this.rows.set(checkpoint.runId, structuredClone(checkpoint)); return true;
  }
  async save(checkpoint: ApsTranslationCheckpoint) { this.rows.set(checkpoint.runId, structuredClone(checkpoint)); }
}
function oauth(expires = 1799) { return Response.json({ token_type: 'Bearer', expires_in: expires, access_token: 'aps-unit-token' }); }
function manifest(status: string, derivativeStatus = status) {
  return { urn: sourceUrn, status, derivatives: [{ outputType: 'svf2', status: derivativeStatus, children: [{ type: 'geometry', status: derivativeStatus }] }] };
}

test('APS key pair alone cannot authorize transmission and each attestation must be explicit', async () => {
  const env = { APS_CLIENT_ID: 'aps-unit-client', APS_CLIENT_SECRET: 'aps-unit-secret', TAKEOFF_V2_APS_ENABLED: 'true',
    TAKEOFF_V2_APS_INTEGRATION_APPROVED: 'true', TAKEOFF_V2_APS_DATA_AUTHORIZED: 'true' };
  for (const key of Object.keys(env)) assert.throws(() => requireApsProviderConfig({ ...env, [key]: '' }), /integration_not_authorized/);
  assert.equal(requireApsProviderConfig(env).clientId, env.APS_CLIENT_ID);
  let requests = 0;
  const adapter = new ApsModelDerivativeAdapter({ clientId: 'x', clientSecret: 'y' }, (async () => { requests++; return oauth(); }) as typeof fetch, new MemoryStore());
  await assert.rejects(adapter.start(input), ApsProviderError);
  assert.equal(requests, 0);
});

test('APS rejects PDF and unsupported formats before OAuth or translation requests', async () => {
  let requests = 0;
  const adapter = new ApsModelDerivativeAdapter(config, (async () => { requests++; return oauth(); }) as typeof fetch, new MemoryStore());
  await assert.rejects(adapter.start({ ...input, sourceFormat: 'pdf' }), /native_cad_bim_required/);
  await assert.rejects(adapter.start({ ...input, objectId: 'urn:adsk.objects:os.object:mock-bucket/synthetic.pdf' }), /invalid_source_object/);
  await assert.rejects(adapter.start({ ...input, sourceFormat: 'exe' }), /native_cad_bim_required/);
  assert.equal(requests, 0);
});

test('APS uses OAuth v2 Basic, scoped form data, URL-safe URN and non-forced asynchronous translation', async () => {
  const store = new MemoryStore(); let clock = epoch;
  const calls: string[] = [];
  const transport = (async (url, init) => {
    const path = new URL(String(url)).pathname; calls.push(path);
    const headers = new Headers(init?.headers);
    assert.equal(init?.redirect, 'manual');
    if (path === '/authentication/v2/token') {
      assert.equal(headers.get('Authorization'), `Basic ${Buffer.from('aps-unit-client:aps-unit-secret').toString('base64')}`);
      assert.equal(headers.get('Content-Type'), 'application/x-www-form-urlencoded');
      assert.deepEqual(Object.fromEntries(new URLSearchParams(String(init?.body))), {
        grant_type: 'client_credentials', scope: 'data:read data:write data:create',
      });
      return oauth();
    }
    assert.equal(headers.get('Authorization'), 'Bearer aps-unit-token');
    if (path.endsWith('/job')) {
      assert.equal(headers.get('x-ads-force'), 'false');
      assert.deepEqual(JSON.parse(String(init?.body)), { input: { urn: sourceUrn }, output: { formats: [{ type: 'svf2', views: ['2d', '3d'] }] } });
      return new Response(null, { status: 200 });
    }
    assert.ok(path.endsWith(`/${sourceUrn}/manifest`));
    return Response.json(manifest(calls.length === 3 ? 'inprogress' : 'success'));
  }) as typeof fetch;
  const adapter = new ApsModelDerivativeAdapter(config, transport, store, () => new Date(clock));
  assert.equal((await adapter.start(input)).state, 'awaiting_manifest');
  assert.ok(!JSON.stringify(adapter).includes(config.clientSecret), 'runtime credentials are private and not serializable');
  assert.ok(!JSON.stringify(adapter).includes('aps-unit-token'), 'OAuth tokens are private and not serializable');
  await adapter.start(input);
  assert.equal(calls.length, 2, 'resume never resubmits');
  assert.equal((await adapter.poll(input.runId)).nextPollAt, '2026-10-02T12:00:30.000Z');
  await adapter.poll(input.runId); assert.equal(calls.length, 3);
  clock += 30_000;
  assert.equal((await adapter.poll(input.runId)).state, 'translation_ready');
  assert.equal(calls.length, 4, 'the cached token is reused');
  const checkpoint = JSON.stringify(await store.load(input.runId));
  assert.ok(!checkpoint.includes('aps-unit-secret') && !checkpoint.includes('aps-unit-token'));
});

test('APS a restarted process obtains a new token without resubmitting the existing job', async () => {
  const store = new MemoryStore(); let jobs = 0; let tokens = 0;
  const transport = (async (url) => {
    if (String(url).endsWith('/token')) { tokens++; return oauth(); }
    if (String(url).endsWith('/job')) { jobs++; return new Response(null, { status: 201 }); }
    return Response.json(manifest('success'));
  }) as typeof fetch;
  await new ApsModelDerivativeAdapter(config, transport, store).start(input);
  const restarted = new ApsModelDerivativeAdapter(config, transport, store);
  await restarted.start(input); await restarted.poll(input.runId);
  assert.equal(jobs, 1); assert.equal(tokens, 2);
});

test('APS respects nested derivative failures and requires proof of the requested output', () => {
  assert.equal(inspectApsManifest(manifest('success'), sourceUrn).outcome, 'ready');
  assert.equal(inspectApsManifest(manifest('success', 'inprogress'), sourceUrn).outcome, 'waiting');
  assert.equal(inspectApsManifest(manifest('success', 'failed'), sourceUrn).outcome, 'failed');
  const nested = manifest('success'); nested.derivatives[0]!.children[0]!.status = 'timeout';
  assert.equal(inspectApsManifest(nested, sourceUrn).outcome, 'failed');
  assert.equal(inspectApsManifest({ urn: sourceUrn, status: 'success', derivatives: [] }, sourceUrn).outcome, 'review');
  assert.equal(inspectApsManifest(manifest('future-state'), sourceUrn).outcome, 'review');
  assert.throws(() => inspectApsManifest(manifest('success'), 'other-urn'), /identity_mismatch/);
});

test('APS a transport timeout after submission or a process crash never triggers a second job', async () => {
  for (const fail of ['transport', 'server']) {
    const store = new MemoryStore(); let jobs = 0;
    const adapter = new ApsModelDerivativeAdapter(config, (async (url) => {
      if (String(url).endsWith('/token')) return oauth();
      jobs++;
      if (fail === 'transport') throw new Error('private upstream details');
      return new Response('private upstream details', { status: 503 });
    }) as typeof fetch, store);
    assert.equal((await adapter.start(input)).state, 'submission_uncertain');
    await adapter.start(input); await adapter.poll(input.runId);
    assert.equal(jobs, 1);
    const checkpoint = (await store.load(input.runId))!;
    await store.save({ ...checkpoint, state: 'submitting' });
    assert.equal((await adapter.poll(input.runId)).state, 'submission_uncertain');
    assert.equal(jobs, 1);
  }
});

test('APS persists Retry-After and prevents terminal auth errors from repeated polling', async () => {
  for (const status of [401, 403, 429, 503]) {
    const store = new MemoryStore(); let polls = 0;
    const adapter = new ApsModelDerivativeAdapter(config, (async (url) => {
      if (String(url).endsWith('/token')) return oauth();
      if (String(url).endsWith('/job')) return new Response(null, { status: 200 });
      polls++; return new Response('private', { status, headers: { 'Retry-After': '120' } });
    }) as typeof fetch, store, () => new Date(epoch));
    await adapter.start(input);
    const checkpoint = await adapter.poll(input.runId);
    assert.equal(checkpoint.state, status === 429 || status === 503 ? 'awaiting_manifest' : 'failed');
    assert.equal(checkpoint.nextPollAt, status === 429 || status === 503 ? '2026-10-02T12:02:00.000Z' : null);
    await adapter.poll(input.runId); assert.equal(polls, 1);
  }
});

test('APS concurrent durable claims submit once and reject a changed source for the same run', async () => {
  const store = new MemoryStore(); let jobs = 0;
  const adapter = new ApsModelDerivativeAdapter(config, (async (url) => {
    if (String(url).endsWith('/token')) return oauth();
    jobs++; return new Response(null, { status: 200 });
  }) as typeof fetch, store);
  await Promise.all([adapter.start(input), adapter.start(input)]);
  assert.equal(jobs, 1);
  await assert.rejects(adapter.start({ ...input, objectId: 'urn:adsk.objects:os.object:mock-bucket/other.rvt' }), /run_input_conflict/);
});

test('APS token expiry renews OAuth and invalid manifest identity stops without final quantities', async () => {
  const store = new MemoryStore(); let clock = epoch; let tokens = 0;
  const adapter = new ApsModelDerivativeAdapter(config, (async (url) => {
    if (String(url).endsWith('/token')) { tokens++; return oauth(120); }
    if (String(url).endsWith('/job')) return new Response(null, { status: 200 });
    return Response.json({ ...manifest('success'), urn: 'another-urn' });
  }) as typeof fetch, store, () => new Date(clock));
  await adapter.start(input); clock += 61_000;
  const checkpoint = await adapter.poll(input.runId);
  assert.equal(tokens, 2);
  assert.equal(checkpoint.state, 'review_required');
  assert.equal(checkpoint.errorCode, 'manifest_identity_mismatch');
});

test('APS OAuth rate limiting after token expiry also persists Retry-After without a manifest request', async () => {
  const store = new MemoryStore(); let clock = epoch; let tokens = 0; let polls = 0;
  const adapter = new ApsModelDerivativeAdapter(config, (async (url) => {
    if (String(url).endsWith('/token')) {
      tokens++; return tokens === 1 ? oauth(120) : new Response('private auth response', { status: 429, headers: { 'Retry-After': '120' } });
    }
    if (String(url).endsWith('/job')) return new Response(null, { status: 200 });
    polls++; return Response.json(manifest('success'));
  }) as typeof fetch, store, () => new Date(clock));
  await adapter.start(input); clock += 61_000;
  const result = await adapter.poll(input.runId);
  assert.equal(result.state, 'awaiting_manifest'); assert.equal(result.errorCode, 'oauth_http_429');
  assert.equal(result.nextPollAt, '2026-10-02T12:03:01.000Z');
  assert.equal(polls, 0);
});
