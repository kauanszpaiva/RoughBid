import { createHash } from 'node:crypto';

/**
 * Experimental, isolated Kamai adapter; it is not wired into a product route.
 * Source: https://api.kamai.io/openapi.json (API 0.1.0, reviewed 2026-10-02).
 * Enablement, integration approval and data/OEM authorization are independent.
 * A key alone never enables transmission. All transport and persistence are injected.
 */
export interface KamaiProviderConfig {
  apiKey: string;
  enabled?: boolean;
  integrationApproved?: boolean;
  dataOemAuthorized?: boolean;
  /** OpenAPI status is a free string; a documentation example is not a terminal-state guarantee. */
  jobSuccessStatus?: string;
  jobSuccessStatusVerified?: boolean;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
}

export class KamaiProviderError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Kamai adapter: ${code}.`);
    this.name = 'KamaiProviderError';
    this.code = code;
  }
}

export function requireKamaiProviderConfig(env: Record<string, string | undefined>): KamaiProviderConfig {
  const config: KamaiProviderConfig = {
    apiKey: env.KAMAI_API_KEY?.trim() ?? '',
    enabled: env.TAKEOFF_V2_KAMAI_ENABLED === 'true',
    integrationApproved: env.TAKEOFF_V2_KAMAI_INTEGRATION_APPROVED === 'true',
    dataOemAuthorized: env.TAKEOFF_V2_KAMAI_DATA_OEM_AUTHORIZED === 'true',
    jobSuccessStatus: env.TAKEOFF_V2_KAMAI_SUCCESS_STATUS?.trim() ?? '',
    jobSuccessStatusVerified: env.TAKEOFF_V2_KAMAI_SUCCESS_STATUS_VERIFIED === 'true',
  };
  assertAuthorized(config);
  return config;
}

function assertAuthorized(config: KamaiProviderConfig): void {
  if (config.enabled !== true || config.integrationApproved !== true || config.dataOemAuthorized !== true
    || config.jobSuccessStatusVerified !== true || !/^[A-Z][A-Z0-9_]{1,63}$/.test(config.jobSuccessStatus ?? '')
    || config.jobSuccessStatus === 'PENDING' || config.jobSuccessStatus === 'RUNNING'
    || !config.apiKey.trim() || /^(?:placeholder|your[_ -]|replace[_ -]|changeme|<)/i.test(config.apiKey.trim())) {
    throw new KamaiProviderError('integration_not_authorized');
  }
}

export interface KamaiMeasurements {
  area_m2: number | null;
  /** SI polygon boundary length, including holes. */
  perimeter_m: number | null;
  length_m: number | null;
  opening_width_m: number | null;
}

export interface KamaiFeatureEvidence {
  id: string;
  kind: 'area' | 'line' | 'object' | 'text' | 'folder';
  semanticClass: string;
  subClass: string | null;
  name: string | null;
  tag: string | null;
  parentId: string | null;
  position: number | null;
  visible: boolean | null;
  relations: string[];
  geometry: Record<string, unknown> | null;
  measurements: KamaiMeasurements;
  /** Evidence only: objects count individually; folders, labels and tags are not quantities. */
  objectCount: 1 | null;
}

export interface KamaiBlueprintEvidence {
  blueprintId: string;
  revision: string | null;
  scale: Record<string, unknown> | null;
  features: KamaiFeatureEvidence[];
  text: KamaiTextEvidence[];
  textTotal: number | null;
  /** No final takeoff/completeness claim is made by this adapter. */
  reviewReasons: string[];
}

export interface KamaiTextEvidence {
  id: string;
  text: string;
  confidence: number | null;
  /** Preserve the provider's potentially rotated word box in blueprint coordinates. */
  geometry: Record<string, unknown> | null;
  roomId: string | null;
  wallId: string | null;
}

export interface KamaiCheckpoint {
  version: 'kamai-adapter-v1';
  runId: string;
  fileSha256: string;
  expectedPageCount: number;
  state: 'submitting' | 'upload_uncertain' | 'awaiting_job' | 'awaiting_blueprint' | 'awaiting_text' | 'review_required' | 'failed';
  projectId: string | null;
  jobId: string | null;
  uploadId: string | null;
  blueprintId: string | null;
  providerStatus: string | null;
  pollAttempts: number;
  nextPollAt: string | null;
  errorCode: string | null;
  evidence: KamaiBlueprintEvidence | null;
  textOffset: number;
}

export interface KamaiCheckpointStore {
  load(runId: string): Promise<KamaiCheckpoint | null>;
  /** Atomically insert if absent. False means another owner already claimed this run. */
  claimInitial(checkpoint: KamaiCheckpoint): Promise<boolean>;
  save(checkpoint: KamaiCheckpoint): Promise<void>;
  /** The host must also enforce its operational deadline/budget and serialize polling with a durable worker lease. */
}

type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new KamaiProviderError('invalid_response');
  return value as JsonRecord;
}
function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new KamaiProviderError('invalid_response');
  return value;
}
function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : requiredString(value);
}
function measurement(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new KamaiProviderError('invalid_measurement');
  return value;
}

const TEXT_PAGE_LIMIT = 1_000;
const MAX_TEXT_WORDS = 100_000;

function textPage(blueprint: JsonRecord): { words: KamaiTextEvidence[]; total: number | null } {
  const entries = blueprint.text ?? [];
  if (!Array.isArray(entries) || entries.length > TEXT_PAGE_LIMIT) throw new KamaiProviderError('invalid_text_page');
  const total = blueprint.text_total == null ? null : blueprint.text_total;
  if (total !== null && (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0)) throw new KamaiProviderError('invalid_text_total');
  const ids = new Set<string>();
  const words = entries.map((entry): KamaiTextEvidence => {
    const word = record(entry);
    const id = requiredString(word.id);
    if (ids.has(id)) throw new KamaiProviderError('duplicate_text_identity');
    ids.add(id);
    if (word.confidence != null && (typeof word.confidence !== 'number' || !Number.isFinite(word.confidence)
      || word.confidence < 0 || word.confidence > 1)) throw new KamaiProviderError('invalid_text_confidence');
    return { id, text: requiredString(word.text), confidence: word.confidence == null ? null : word.confidence as number,
      geometry: word.geometry == null ? null : record(word.geometry), roomId: nullableString(word.room_id), wallId: nullableString(word.wall_id) };
  });
  if (total !== null && words.length > (total as number)) throw new KamaiProviderError('invalid_text_total');
  return { words, total: total as number | null };
}

/** SI values are copied verbatim. Geometry/scale never rescales server measurements. */
export function normalizeKamaiBlueprint(payload: unknown, expectedBlueprintId: string): KamaiBlueprintEvidence {
  const response = record(payload);
  const blueprint = record(response.blueprint);
  const blueprintId = requiredString(blueprint.id);
  if (blueprintId !== expectedBlueprintId) throw new KamaiProviderError('blueprint_identity_mismatch');
  const scale = blueprint.scale == null ? null : record(blueprint.scale);
  const reviewReasons = ['multipage_completeness_unverified'];
  if (!scale) reviewReasons.push('scale_missing');
  else if (scale.manual_scaling_needed === true) reviewReasons.push('manual_scaling_required');
  else if (scale.manual_scaling_needed !== false) reviewReasons.push('scale_verification_unknown');
  const collection = blueprint.geojson == null ? null : record(blueprint.geojson);
  if (!collection) reviewReasons.push('geometry_missing');
  if (collection && (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features))) {
    throw new KamaiProviderError('invalid_geojson');
  }
  const featureIds = new Set<string>();
  const features = ((collection?.features ?? []) as unknown[]).map((entry): KamaiFeatureEvidence => {
    const feature = record(entry);
    const properties = record(feature.properties);
    const id = requiredString(properties.id);
    if (featureIds.has(id) || (feature.id != null && feature.id !== id)) throw new KamaiProviderError('invalid_feature_identity');
    featureIds.add(id);
    const kind = properties.kind;
    if (kind !== 'area' && kind !== 'line' && kind !== 'object' && kind !== 'text' && kind !== 'folder') {
      throw new KamaiProviderError('unknown_feature_kind');
    }
    const geometry = feature.geometry == null ? null : record(feature.geometry);
    if (kind === 'folder' && geometry) throw new KamaiProviderError('invalid_folder_geometry');
    if (kind !== 'folder' && !geometry && !reviewReasons.includes('feature_geometry_missing')) reviewReasons.push('feature_geometry_missing');
    const values = properties.measurements == null ? {} : record(properties.measurements);
    const measurements: KamaiMeasurements = {
      area_m2: measurement(values.area_m2), perimeter_m: measurement(values.perimeter_m),
      length_m: measurement(values.length_m), opening_width_m: measurement(values.opening_width_m),
    };
    if (kind === 'folder' && Object.values(measurements).some(value => value !== null)) throw new KamaiProviderError('invalid_folder_measurement');
    const relations = properties.relations ?? [];
    if (!Array.isArray(relations)) throw new KamaiProviderError('invalid_relations');
    if (properties.position != null && (typeof properties.position !== 'number' || !Number.isFinite(properties.position))) {
      throw new KamaiProviderError('invalid_hierarchy');
    }
    if (properties.visible != null && typeof properties.visible !== 'boolean') throw new KamaiProviderError('invalid_visibility');
    return {
      id, kind, semanticClass: requiredString(properties.class), subClass: nullableString(properties.sub_class),
      name: nullableString(properties.name), tag: nullableString(properties.tag), parentId: nullableString(properties.parent_id),
      position: properties.position == null ? null : properties.position as number,
      visible: properties.visible == null ? null : properties.visible as boolean,
      relations: relations.map(requiredString), geometry, measurements, objectCount: kind === 'object' ? 1 : null,
    };
  });
  if (features.some(feature => feature.relations.some(id => !featureIds.has(id))
    || (feature.parentId !== null && !featureIds.has(feature.parentId)))) reviewReasons.push('unresolved_feature_relations');
  const text = textPage(blueprint);
  return { blueprintId, revision: nullableString(response.revision), scale, features, text: text.words, textTotal: text.total, reviewReasons };
}

const BASE_URL = 'https://api.kamai.io';
const MAX_RESPONSE_BYTES = 4_000_000;

/** Each poll performs one HTTP request and persists its next schedule; no sleep/long-held HTTP request. */
export class KamaiTakeoffAdapter {
  readonly #config: KamaiProviderConfig;
  private readonly transport: typeof fetch;
  private readonly store: KamaiCheckpointStore;
  private readonly now: () => Date;

  constructor(config: KamaiProviderConfig, transport: typeof fetch, store: KamaiCheckpointStore, now: () => Date = () => new Date()) {
    this.#config = { ...config };
    this.transport = transport;
    this.store = store;
    this.now = now;
    for (const value of [config.pollIntervalMs ?? 30_000, config.requestTimeoutMs ?? 30_000]) {
      if (!Number.isSafeInteger(value) || value < 1_000 || value > 300_000) throw new KamaiProviderError('invalid_timing_configuration');
    }
  }

  async submit(input: {
    runId: string; fileSha256: string; expectedPageCount: number; filename: string; fileBytes: Uint8Array; projectId?: string;
  }): Promise<KamaiCheckpoint> {
    assertAuthorized(this.#config);
    if (input.fileBytes.byteLength > 25_000_000) throw new KamaiProviderError('invalid_pdf_input');
    const fileBytes = new Uint8Array(input.fileBytes);
    if (!input.runId.trim() || !/^[a-f0-9]{64}$/i.test(input.fileSha256) || !Number.isSafeInteger(input.expectedPageCount)
      || input.expectedPageCount < 1 || !/\.pdf$/i.test(input.filename)
      || !Buffer.from(fileBytes.subarray(0, 5)).equals(Buffer.from('%PDF-'))
      || createHash('sha256').update(fileBytes).digest('hex') !== input.fileSha256.toLowerCase()) throw new KamaiProviderError('invalid_pdf_input');
    const existing = await this.store.load(input.runId);
    if (existing) return this.existing(existing, input.fileSha256, input.expectedPageCount);
    const checkpoint: KamaiCheckpoint = {
      version: 'kamai-adapter-v1', runId: input.runId, fileSha256: input.fileSha256.toLowerCase(), expectedPageCount: input.expectedPageCount,
      state: 'submitting', projectId: input.projectId ?? null, jobId: null, uploadId: null, blueprintId: null,
      providerStatus: null, pollAttempts: 0, nextPollAt: null, errorCode: null, evidence: null, textOffset: 0,
    };
    if (!await this.store.claimInitial(checkpoint)) {
      const claimed = await this.store.load(input.runId);
      if (!claimed) throw new KamaiProviderError('persistence_conflict');
      return this.existing(claimed, input.fileSha256, input.expectedPageCount);
    }
    const form = new FormData();
    form.append('file', new Blob([fileBytes], { type: 'application/pdf' }), input.filename);
    const url = new URL('/v1/blueprints/upload', BASE_URL);
    if (input.projectId) url.searchParams.set('project_id', input.projectId);
    let response: Response;
    try { response = await this.request(url, { method: 'POST', body: form }); }
    catch { return this.persist({ ...checkpoint, state: 'upload_uncertain', errorCode: 'upload_outcome_unknown' }); }
    if (!response.ok) {
      // A server error or redirect can conceal an accepted upload. Never retry the POST automatically.
      const uncertain = response.status >= 500 || (response.status >= 300 && response.status < 400);
      return this.persist({ ...checkpoint, state: uncertain ? 'upload_uncertain' : 'failed', errorCode: `upload_http_${response.status}` });
    }
    let submitted: KamaiCheckpoint;
    try {
      const body = record(await this.json(response));
      const projectId = requiredString(body.project_id);
      if (input.projectId && input.projectId !== projectId) throw new KamaiProviderError('project_identity_mismatch');
      submitted = { ...checkpoint, projectId, jobId: requiredString(body.job_id), uploadId: nullableString(body.upload_id),
        state: 'awaiting_job', nextPollAt: this.now().toISOString() };
    } catch {
      return this.persist({ ...checkpoint, state: 'upload_uncertain', errorCode: 'upload_response_unverified' });
    }
    // A failed persistence write must surface; it cannot be relabeled a provider error.
    return this.persist(submitted);
  }

  async poll(runId: string): Promise<KamaiCheckpoint> {
    assertAuthorized(this.#config);
    const checkpoint = await this.store.load(runId);
    if (!checkpoint) throw new KamaiProviderError('checkpoint_not_found');
    if (checkpoint.state === 'submitting') return this.persist({ ...checkpoint, state: 'upload_uncertain', errorCode: 'upload_outcome_unknown' });
    if (checkpoint.state !== 'awaiting_job' && checkpoint.state !== 'awaiting_blueprint' && checkpoint.state !== 'awaiting_text') return checkpoint;
    if (checkpoint.nextPollAt && Date.parse(checkpoint.nextPollAt) > this.now().getTime()) return checkpoint;
    if (!checkpoint.projectId || !checkpoint.jobId) throw new KamaiProviderError('checkpoint_ids_missing');
    const path = checkpoint.state === 'awaiting_job'
      ? `/v1/projects/${encodeURIComponent(checkpoint.projectId)}/jobs/${encodeURIComponent(checkpoint.jobId)}`
      : `/v1/blueprints/${encodeURIComponent(checkpoint.blueprintId ?? '')}`;
    if (checkpoint.state !== 'awaiting_job' && !checkpoint.blueprintId) throw new KamaiProviderError('checkpoint_ids_missing');
    const url = new URL(path, BASE_URL);
    if (checkpoint.state !== 'awaiting_job') {
      url.searchParams.set('include_text', 'true');
      url.searchParams.set('text_limit', String(TEXT_PAGE_LIMIT));
      url.searchParams.set('text_offset', String(checkpoint.textOffset));
    }
    const attempted = { ...checkpoint, pollAttempts: checkpoint.pollAttempts + 1 };
    let response: Response;
    try { response = await this.request(url, { method: 'GET' }); }
    catch { return this.schedule(attempted, 'poll_transport_unavailable'); }
    if (response.status === 429 || response.status >= 500) return this.schedule(attempted, `poll_http_${response.status}`, response);
    if (!response.ok) return this.persist({ ...attempted, state: 'failed', nextPollAt: null, errorCode: `poll_http_${response.status}` });
    let body: unknown;
    try { body = await this.json(response); }
    catch { return this.persist({ ...attempted, state: 'review_required', nextPollAt: null, errorCode: 'invalid_response' }); }
    try {
      if (checkpoint.state === 'awaiting_blueprint') {
        const evidence = normalizeKamaiBlueprint(body, checkpoint.blueprintId!);
        return this.textProgress({ ...attempted, evidence, textOffset: evidence.text.length });
      }
      if (checkpoint.state === 'awaiting_text') {
        if (!checkpoint.evidence) throw new KamaiProviderError('text_checkpoint_missing');
        const responseBody = record(body);
        const blueprint = record(responseBody.blueprint);
        if (requiredString(blueprint.id) !== checkpoint.blueprintId) throw new KamaiProviderError('blueprint_identity_mismatch');
        if (nullableString(responseBody.revision) !== checkpoint.evidence.revision) throw new KamaiProviderError('text_revision_changed');
        const page = textPage(blueprint);
        if (page.total !== checkpoint.evidence.textTotal || page.words.length === 0) throw new KamaiProviderError('text_pagination_inconsistent');
        const ids = new Set(checkpoint.evidence.text.map(word => word.id));
        if (page.words.some(word => ids.has(word.id))) throw new KamaiProviderError('duplicate_text_identity');
        const evidence = { ...checkpoint.evidence, text: [...checkpoint.evidence.text, ...page.words] };
        return this.textProgress({ ...attempted, evidence, textOffset: checkpoint.textOffset + page.words.length });
      }
      const job = record(record(body).job);
      if (requiredString(job.id) !== checkpoint.jobId) throw new KamaiProviderError('job_identity_mismatch');
      const status = requiredString(job.status);
      const blueprintId = requiredString(job.blueprint_id);
      const updated = { ...attempted, blueprintId, providerStatus: status, errorCode: null };
      if (status === 'PENDING' || status === 'RUNNING') return this.schedule(updated, null);
      // An explicitly attested status only permits artifact retrieval; it never proves full-set completion.
      if (status === this.#config.jobSuccessStatus) return this.persist({ ...updated, state: 'awaiting_blueprint', nextPollAt: this.now().toISOString() });
      // Failure/cancel spellings are not enumerated by OpenAPI. Preserve status, stop and request review.
      return this.persist({ ...updated, state: 'review_required', nextPollAt: null, errorCode: 'unknown_job_status' });
    } catch (error) {
      if (!(error instanceof KamaiProviderError)) throw error;
      return this.persist({ ...attempted, state: 'review_required', nextPollAt: null, errorCode: error.code });
    }
  }

  private existing(checkpoint: KamaiCheckpoint, hash: string, pageCount: number): KamaiCheckpoint {
    if (checkpoint.fileSha256 !== hash.toLowerCase() || checkpoint.expectedPageCount !== pageCount) throw new KamaiProviderError('run_input_conflict');
    return checkpoint;
  }
  private textProgress(checkpoint: KamaiCheckpoint): Promise<KamaiCheckpoint> {
    const evidence = checkpoint.evidence;
    if (!evidence) throw new KamaiProviderError('text_checkpoint_missing');
    if (evidence.textTotal === null) return this.persist({ ...checkpoint, state: 'review_required', nextPollAt: null, errorCode: 'text_total_missing' });
    if (evidence.textTotal > MAX_TEXT_WORDS) return this.persist({ ...checkpoint, state: 'review_required', nextPollAt: null, errorCode: 'text_word_limit_exceeded' });
    if (checkpoint.textOffset > evidence.textTotal) throw new KamaiProviderError('text_pagination_inconsistent');
    if (checkpoint.textOffset < evidence.textTotal) {
      if (checkpoint.textOffset === 0) throw new KamaiProviderError('text_pagination_inconsistent');
      // Without revision the host cannot prove a coherent multi-page OCR snapshot; preserve that limitation.
      if (evidence.revision === null && !evidence.reviewReasons.includes('text_revision_unverified')) evidence.reviewReasons.push('text_revision_unverified');
      return this.persist({ ...checkpoint, state: 'awaiting_text', nextPollAt: this.now().toISOString(), errorCode: null });
    }
    return this.persist({ ...checkpoint, state: 'review_required', nextPollAt: null, errorCode: 'multipage_completeness_unverified' });
  }
  private request(url: URL, init: RequestInit): Promise<Response> {
    return this.transport(url, { ...init, redirect: 'manual', headers: { Authorization: `Bearer ${this.#config.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(this.#config.requestTimeoutMs ?? 30_000) });
  }
  private async json(response: Response): Promise<unknown> {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new KamaiProviderError('response_too_large');
    return JSON.parse(text) as unknown;
  }
  private schedule(checkpoint: KamaiCheckpoint, errorCode: string | null, response?: Response): Promise<KamaiCheckpoint> {
    const retryHeader = response?.headers.get('retry-after');
    const seconds = retryHeader && /^\d+(?:\.\d+)?$/.test(retryHeader) ? Number(retryHeader) : null;
    const dateDelay = retryHeader && seconds === null ? Date.parse(retryHeader) - this.now().getTime() : 0;
    const delay = Math.max(this.#config.pollIntervalMs ?? 30_000, seconds === null ? (Number.isFinite(dateDelay) ? dateDelay : 0) : seconds * 1_000);
    if (!Number.isFinite(delay) || delay > 7 * 86_400_000) return this.persist({ ...checkpoint, state: 'review_required', nextPollAt: null, errorCode: 'retry_window_unverified' });
    return this.persist({ ...checkpoint, errorCode, nextPollAt: new Date(this.now().getTime() + delay).toISOString() });
  }
  private async persist(checkpoint: KamaiCheckpoint): Promise<KamaiCheckpoint> {
    await this.store.save(checkpoint);
    return checkpoint;
  }
}
