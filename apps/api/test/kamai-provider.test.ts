import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  KamaiTakeoffAdapter, KamaiProviderError, normalizeKamaiBlueprint, requireKamaiProviderConfig,
  type KamaiCheckpoint, type KamaiCheckpointStore, type KamaiProviderConfig,
} from '../src/takeoff-v2/kamai-provider.ts';

const config: KamaiProviderConfig = {
  apiKey: 'kamai-unit-test-value', enabled: true, integrationApproved: true, dataOemAuthorized: true,
  jobSuccessStatus: 'SUCCEEDED', jobSuccessStatusVerified: true,
};
const epoch = Date.parse('2026-10-02T12:00:00Z');
const bytes = new Uint8Array(Buffer.from('%PDF-1.7\nsynthetic mock payload'));
const input = { runId: 'run-1', fileSha256: createHash('sha256').update(bytes).digest('hex'),
  expectedPageCount: 2, filename: 'synthetic.pdf', fileBytes: bytes, projectId: 'project-1' };

class MemoryStore implements KamaiCheckpointStore {
  rows = new Map<string, KamaiCheckpoint>();
  async load(runId: string) { return structuredClone(this.rows.get(runId) ?? null); }
  async claimInitial(checkpoint: KamaiCheckpoint) {
    if (this.rows.has(checkpoint.runId)) return false;
    this.rows.set(checkpoint.runId, structuredClone(checkpoint)); return true;
  }
  async save(checkpoint: KamaiCheckpoint) { this.rows.set(checkpoint.runId, structuredClone(checkpoint)); }
}

function upload() { return Response.json({ job_id: 'job-1', project_id: 'project-1', upload_id: 'upload-1' }); }
function job(status: string) { return Response.json({ job: { id: 'job-1', status, blueprint_id: 'blueprint-1', filename: 'synthetic.pdf' } }); }
function blueprint(manual = false) {
  const feature = (id: string, kind: string, values: Record<string, unknown>, tag: string | null = null) => ({
    type: 'Feature', id, geometry: kind === 'folder' ? null : { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    properties: { id, kind, class: kind === 'object' ? 'opening' : kind === 'folder' ? 'other' : 'room', tag,
      parent_id: kind === 'folder' ? null : 'root', relations: [], measurements: values },
  });
  return { revision: 'opaque-revision', blueprint: { id: 'blueprint-1', text: [] as Array<Record<string, unknown>>, text_total: 0, scale: {
    drawing: 0.25, real: 12, units: 'imperial', type: 'architectural', manual_scaling_needed: manual,
  }, geojson: { type: 'FeatureCollection', features: [
    feature('root', 'folder', {}), feature('room-1', 'area', { area_m2: 8.324112384, perimeter_m: 11.70432, length_m: null }),
    feature('door-1', 'object', { area_m2: 0.07, opening_width_m: 0.747776 }, 'D-01'),
    feature('door-2', 'object', { opening_width_m: 0 }, 'D-01'),
  ] } } };
}

test('Kamai key alone does not enable data transmission; every attestation is independent', async () => {
  const env = { KAMAI_API_KEY: 'kamai-unit-test-value', TAKEOFF_V2_KAMAI_ENABLED: 'true',
    TAKEOFF_V2_KAMAI_INTEGRATION_APPROVED: 'true', TAKEOFF_V2_KAMAI_DATA_OEM_AUTHORIZED: 'true',
    TAKEOFF_V2_KAMAI_SUCCESS_STATUS: 'SUCCEEDED', TAKEOFF_V2_KAMAI_SUCCESS_STATUS_VERIFIED: 'true' };
  for (const key of Object.keys(env)) assert.throws(() => requireKamaiProviderConfig({ ...env, [key]: '' }), /integration_not_authorized/);
  assert.equal(requireKamaiProviderConfig(env).apiKey, env.KAMAI_API_KEY);
  let requests = 0;
  const adapter = new KamaiTakeoffAdapter({ apiKey: 'key-only' }, (async () => { requests++; return upload(); }) as typeof fetch, new MemoryStore());
  await assert.rejects(adapter.submit(input), KamaiProviderError);
  assert.equal(requests, 0);
});

test('Kamai claims upload once, persists IDs and resumes with one request per polling step', async () => {
  const store = new MemoryStore();
  let clock = epoch;
  const calls: string[] = [];
  const responses = [upload(), job('PENDING'), job('RUNNING'), job('SUCCEEDED'), Response.json(blueprint())];
  const transport = (async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer kamai-unit-test-value');
    if (init?.method === 'POST') {
      assert.ok(init.body instanceof FormData);
      assert.equal(new Headers(init.headers).get('Content-Type'), null, 'fetch must supply multipart boundary');
      assert.ok(init.body.get('file') instanceof Blob);
    }
    return responses.shift()!;
  }) as typeof fetch;
  const adapter = new KamaiTakeoffAdapter(config, transport, store, () => new Date(clock));
  assert.ok(!JSON.stringify(adapter).includes(config.apiKey), 'private runtime credentials are not serializable');
  const submitted = await adapter.submit(input);
  assert.deepEqual([submitted.projectId, submitted.jobId, submitted.uploadId], ['project-1', 'job-1', 'upload-1']);
  const resumed = new KamaiTakeoffAdapter(config, transport, store, () => new Date(clock));
  await resumed.submit(input);
  await resumed.submit({ ...input, fileSha256: input.fileSha256.toUpperCase() });
  assert.equal(calls.length, 1);
  const pending = await resumed.poll(input.runId);
  assert.equal(pending.nextPollAt, '2026-10-02T12:00:30.000Z');
  await resumed.poll(input.runId);
  assert.equal(calls.length, 2, 'not due means no request');
  clock += 30_000;
  await resumed.poll(input.runId);
  clock += 30_000;
  assert.equal((await resumed.poll(input.runId)).state, 'awaiting_blueprint');
  const result = await resumed.poll(input.runId);
  assert.equal(calls.length, 5);
  assert.equal(result.state, 'review_required');
  assert.equal(result.errorCode, 'multipage_completeness_unverified');
  assert.equal(result.evidence?.revision, 'opaque-revision');
  assert.equal((await store.load(input.runId))?.nextPollAt, null);
  assert.match(calls[0]!, /project_id=project-1/);
  assert.match(calls[1]!, /\/v1\/projects\/project-1\/jobs\/job-1$/);
});

test('Kamai preserves SI, null and zero without imperial re-scaling; duplicate tags remain distinct objects', () => {
  const evidence = normalizeKamaiBlueprint(blueprint(), 'blueprint-1');
  assert.equal(evidence.features[1]?.measurements.area_m2, 8.324112384);
  assert.equal(evidence.features[1]?.measurements.length_m, null);
  assert.equal(evidence.features[2]?.measurements.opening_width_m, 0.747776);
  assert.equal(evidence.features[3]?.measurements.opening_width_m, 0);
  assert.equal(evidence.features[0]?.objectCount, null);
  assert.equal(evidence.features.filter(feature => feature.objectCount === 1).length, 2);
  assert.equal(evidence.features[2]?.tag, evidence.features[3]?.tag);
  assert.equal(evidence.features[2]?.measurements.area_m2, 0.07, 'object geometry evidence remains separate from room areas');
  assert.deepEqual(evidence.reviewReasons, ['multipage_completeness_unverified']);
  assert.ok(normalizeKamaiBlueprint(blueprint(true), 'blueprint-1').reviewReasons.includes('manual_scaling_required'));
});

test('Kamai rejects identities/invalid measures and marks missing geometry/scale for review', () => {
  assert.throws(() => normalizeKamaiBlueprint(blueprint(), 'another-blueprint'), /identity_mismatch/);
  const duplicate = blueprint(); duplicate.blueprint.geojson.features[3]!.properties.id = 'door-1';
  assert.throws(() => normalizeKamaiBlueprint(duplicate, 'blueprint-1'), /invalid_feature_identity/);
  const invalid = blueprint(); invalid.blueprint.geojson.features[1]!.properties.measurements.area_m2 = -1;
  assert.throws(() => normalizeKamaiBlueprint(invalid, 'blueprint-1'), /invalid_measurement/);
  const noGeometry = normalizeKamaiBlueprint({ blueprint: { id: 'blueprint-1', geojson: null, scale: null } }, 'blueprint-1');
  assert.ok(noGeometry.reviewReasons.includes('scale_missing'));
  assert.ok(noGeometry.reviewReasons.includes('geometry_missing'));
});

test('Kamai never automatically reuploads after transport ambiguity, bad success response or server error', async () => {
  for (const response of [new Response('upstream-private', { status: 503 }), Response.json({ project_id: 'project-1' }), null]) {
    const store = new MemoryStore(); let requests = 0;
    const transport = (async () => { requests++; if (!response) throw new Error('upstream-private'); return response; }) as typeof fetch;
    const adapter = new KamaiTakeoffAdapter(config, transport, store);
    const submitted = await adapter.submit(input);
    assert.equal(submitted.state, 'upload_uncertain');
    await adapter.submit(input); await adapter.poll(input.runId);
    assert.equal(requests, 1);
    assert.ok(!JSON.stringify(submitted).includes('upstream-private'));
  }
});

test('Kamai durable claim prevents two concurrent uploads and keeps a crash during submission ambiguous', async () => {
  const store = new MemoryStore(); let requests = 0;
  const transport = (async () => { requests++; return upload(); }) as typeof fetch;
  const adapter = new KamaiTakeoffAdapter(config, transport, store);
  await Promise.all([adapter.submit(input), adapter.submit(input)]);
  assert.equal(requests, 1);
  await assert.rejects(adapter.submit({ ...input, expectedPageCount: 3 }), /run_input_conflict/);
  const claimed = (await store.load(input.runId))!;
  await store.save({ ...claimed, state: 'submitting', jobId: null });
  assert.equal((await adapter.poll(input.runId)).state, 'upload_uncertain');
  assert.equal(requests, 1);
});

test('Kamai GET retries persist Retry-After and terminal auth/validation errors stop polling', async () => {
  for (const status of [401, 403, 422, 429, 503]) {
    const store = new MemoryStore(); let requests = 0;
    const adapter = new KamaiTakeoffAdapter(config, (async () => {
      requests++; return requests === 1 ? upload() : new Response('private', { status, headers: { 'Retry-After': '90' } });
    }) as typeof fetch, store, () => new Date(epoch));
    await adapter.submit(input);
    const checkpoint = await adapter.poll(input.runId);
    assert.equal(checkpoint.state, status === 429 || status === 503 ? 'awaiting_job' : 'failed');
    assert.equal(checkpoint.nextPollAt, status === 429 || status === 503 ? '2026-10-02T12:01:30.000Z' : null);
    await adapter.poll(input.runId);
    assert.equal(requests, 2);
  }
});

test('Kamai unknown job status and mismatched job identity require review without reading a blueprint', async () => {
  for (const payload of [{ job: { id: 'job-1', status: 'FUTURE_STATE', blueprint_id: 'blueprint-1' } },
    { job: { id: 'other-job', status: 'SUCCEEDED', blueprint_id: 'blueprint-1' } }]) {
    const store = new MemoryStore(); let requests = 0;
    const adapter = new KamaiTakeoffAdapter(config, (async () => { requests++; return requests === 1 ? upload() : Response.json(payload); }) as typeof fetch, store);
    await adapter.submit(input);
    assert.equal((await adapter.poll(input.runId)).state, 'review_required');
    await adapter.poll(input.runId);
    assert.equal(requests, 2);
  }
});

test('Kamai validates the content hash and surfaces persistence failure after an accepted upload', async () => {
  const store = new MemoryStore(); let requests = 0;
  const adapter = new KamaiTakeoffAdapter(config, (async () => { requests++; return upload(); }) as typeof fetch, store);
  await assert.rejects(adapter.submit({ ...input, fileSha256: '0'.repeat(64) }), /invalid_pdf_input/);
  assert.equal(requests, 0);
  store.save = async () => { throw new Error('local checkpoint unavailable'); };
  await assert.rejects(adapter.submit(input), /local checkpoint unavailable/);
  await adapter.submit(input);
  assert.equal(requests, 1, 'the initial durable claim survives a failed ID checkpoint write');
});

test('Kamai OCR paging persists offsets, survives restart and preserves rotated boxes and word IDs', async () => {
  const store = new MemoryStore(); const calls: string[] = [];
  const rotatedBox = { type: 'Polygon', coordinates: [[[1, 2], [4, 6], [3, 7], [0, 3], [1, 2]]] };
  const first = blueprint(); first.blueprint.text_total = 3;
  first.blueprint.text = [{ id: 'word-1', text: 'ROOM', confidence: 0.97, geometry: rotatedBox, room_id: 'room-1' }];
  const last = { revision: 'opaque-revision', blueprint: { id: 'blueprint-1', text_total: 3, text: [
    { id: 'word-2', text: 'A', confidence: 1, geometry: rotatedBox },
    { id: 'word-3', text: 'A', confidence: null, wall_id: 'wall-1' },
  ] } };
  const responses = [upload(), job('SUCCEEDED'), Response.json(first), Response.json(last)];
  const transport = (async (url) => { calls.push(String(url)); return responses.shift()!; }) as typeof fetch;
  const adapter = new KamaiTakeoffAdapter(config, transport, store);
  await adapter.submit(input); await adapter.poll(input.runId);
  const partial = await adapter.poll(input.runId);
  assert.equal(partial.state, 'awaiting_text'); assert.equal(partial.textOffset, 1);
  const restarted = new KamaiTakeoffAdapter(config, transport, store);
  await restarted.submit(input);
  const finished = await restarted.poll(input.runId);
  assert.equal(finished.state, 'review_required'); assert.equal(finished.textOffset, 3);
  assert.equal(finished.evidence?.textTotal, 3);
  assert.deepEqual(finished.evidence?.text.map(word => word.id), ['word-1', 'word-2', 'word-3']);
  assert.deepEqual(finished.evidence?.text[0]?.geometry, rotatedBox);
  assert.equal(finished.evidence?.text[0]?.confidence, 0.97);
  assert.equal(finished.evidence?.text[2]?.confidence, null);
  assert.equal(new URL(calls[2]!).searchParams.get('include_text'), 'true');
  assert.equal(new URL(calls[2]!).searchParams.get('text_limit'), '1000');
  assert.equal(new URL(calls[3]!).searchParams.get('text_offset'), '1');
  assert.equal(calls.filter(url => url.includes('/upload')).length, 1);
});

test('Kamai OCR changed revision or inconsistent totals stop with explicit incomplete evidence', async () => {
  for (const variant of ['revision', 'total', 'duplicate', 'empty']) {
    const store = new MemoryStore();
    const first = blueprint(); first.blueprint.text_total = 2; first.blueprint.text = [{ id: 'word-1', text: 'ROOM' }];
    const second = { revision: variant === 'revision' ? 'changed' : 'opaque-revision', blueprint: { id: 'blueprint-1',
      text_total: variant === 'total' ? 3 : 2, text: variant === 'empty' ? [] : [{ id: variant === 'duplicate' ? 'word-1' : 'word-2', text: 'ROOM' }] } };
    const responses = [upload(), job('SUCCEEDED'), Response.json(first), Response.json(second)];
    const adapter = new KamaiTakeoffAdapter(config, (async () => responses.shift()!) as typeof fetch, store);
    await adapter.submit(input); await adapter.poll(input.runId); await adapter.poll(input.runId);
    const result = await adapter.poll(input.runId);
    assert.equal(result.state, 'review_required'); assert.equal(result.textOffset, 1);
    assert.equal(result.evidence?.text.length, 1); assert.equal(result.evidence?.textTotal, 2);
    assert.notEqual(result.errorCode, 'multipage_completeness_unverified');
    assert.equal(result.nextPollAt, null);
  }
});

test('Kamai OCR missing total or exceeding its local bound never silently claims complete text', async () => {
  for (const total of [null, 100_001]) {
    const store = new MemoryStore();
    const body = blueprint() as unknown as Record<string, any>;
    body.blueprint.text_total = total;
    const responses = [upload(), job('SUCCEEDED'), Response.json(body)];
    const adapter = new KamaiTakeoffAdapter(config, (async () => responses.shift()!) as typeof fetch, store);
    await adapter.submit(input); await adapter.poll(input.runId);
    const result = await adapter.poll(input.runId);
    assert.equal(result.state, 'review_required');
    assert.equal(result.errorCode, total === null ? 'text_total_missing' : 'text_word_limit_exceeded');
  }
});
