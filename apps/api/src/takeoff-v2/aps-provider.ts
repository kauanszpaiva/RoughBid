/**
 * Experimental CAD/BIM translation adapter, not a product takeoff implementation.
 * No upload is implemented here: an authorized host must supply an existing OSS object.
 * PDF stays on RoughBid's PDF path. Credentials are injected at runtime, never checkpointed.
 * Sources: APS OAuth v2 docs and autodesk-platform-services/aps-sdk-openapi.
 */
export interface ApsProviderConfig {
  clientId: string;
  clientSecret: string;
  enabled?: boolean;
  integrationApproved?: boolean;
  dataAuthorized?: boolean;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
}

export class ApsProviderError extends Error {
  readonly code: string;
  readonly retryAfter: string | null;
  constructor(code: string, retryAfter: string | null = null) {
    super(`APS adapter: ${code}.`);
    this.name = 'ApsProviderError';
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function assertAuthorized(config: ApsProviderConfig): void {
  if (config.enabled !== true || config.integrationApproved !== true || config.dataAuthorized !== true
    || !config.clientId.trim() || !config.clientSecret.trim()
    || [config.clientId, config.clientSecret].some(value => /^(?:placeholder|your[_ -]|replace[_ -]|changeme|<)/i.test(value.trim()))) {
    throw new ApsProviderError('integration_not_authorized');
  }
}

export function requireApsProviderConfig(env: Record<string, string | undefined>): ApsProviderConfig {
  const config: ApsProviderConfig = {
    clientId: env.APS_CLIENT_ID?.trim() ?? '', clientSecret: env.APS_CLIENT_SECRET?.trim() ?? '',
    enabled: env.TAKEOFF_V2_APS_ENABLED === 'true',
    integrationApproved: env.TAKEOFF_V2_APS_INTEGRATION_APPROVED === 'true',
    dataAuthorized: env.TAKEOFF_V2_APS_DATA_AUTHORIZED === 'true',
  };
  assertAuthorized(config);
  return config;
}

export type ApsNativeFormat = 'rvt' | 'ifc' | 'dwg' | 'dxf' | 'dgn' | 'nwd' | 'nwc' | 'skp';
const NATIVE_FORMATS = new Set<string>(['rvt', 'ifc', 'dwg', 'dxf', 'dgn', 'nwd', 'nwc', 'skp']);

export interface ApsTranslationCheckpoint {
  version: 'aps-adapter-v1';
  runId: string;
  sourceFormat: ApsNativeFormat;
  sourceUrn: string;
  outputType: 'svf2';
  state: 'submitting' | 'submission_uncertain' | 'awaiting_manifest' | 'translation_ready' | 'review_required' | 'failed';
  providerStatus: string | null;
  pollAttempts: number;
  nextPollAt: string | null;
  errorCode: string | null;
}

export interface ApsCheckpointStore {
  load(runId: string): Promise<ApsTranslationCheckpoint | null>;
  /** Atomic insert-if-absent; the host also enforces its deadline/budget and holds a durable polling lease. */
  claimInitial(checkpoint: ApsTranslationCheckpoint): Promise<boolean>;
  save(checkpoint: ApsTranslationCheckpoint): Promise<void>;
}

type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApsProviderError('invalid_response');
  return value as JsonRecord;
}
function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_048) throw new ApsProviderError('invalid_response');
  return value;
}

const BASE_URL = 'https://developer.api.autodesk.com';
const KNOWN_STATUSES = new Set(['pending', 'inprogress', 'success', 'failed', 'timeout']);

/** Ready means translation only; quantities, units and source coverage require later integration. */
export function inspectApsManifest(payload: unknown, sourceUrn: string): { status: string; outcome: 'waiting' | 'ready' | 'failed' | 'review'; errorCode: string | null } {
  const manifest = record(payload);
  if (requiredString(manifest.urn) !== sourceUrn) throw new ApsProviderError('manifest_identity_mismatch');
  const status = requiredString(manifest.status);
  if (!KNOWN_STATUSES.has(status)) return { status, outcome: 'review', errorCode: 'unknown_manifest_status' };
  if (status === 'failed' || status === 'timeout') return { status, outcome: 'failed', errorCode: `translation_${status}` };
  if (status !== 'success') return { status, outcome: 'waiting', errorCode: null };
  if (!Array.isArray(manifest.derivatives)) throw new ApsProviderError('invalid_manifest_derivatives');
  const requested = manifest.derivatives.map(record).filter(derivative => derivative.outputType === 'svf2');
  if (requested.length === 0) return { status, outcome: 'review', errorCode: 'requested_derivative_missing' };
  const statuses: string[] = [];
  function visit(derivative: JsonRecord, depth: number): void {
    if (depth > 20) throw new ApsProviderError('manifest_too_deep');
    if (derivative.status !== undefined) statuses.push(requiredString(derivative.status));
    else if (depth === 0) throw new ApsProviderError('derivative_status_missing');
    if (derivative.children !== undefined) {
      if (!Array.isArray(derivative.children)) throw new ApsProviderError('invalid_manifest_children');
      derivative.children.forEach(child => visit(record(child), depth + 1));
    }
  }
  requested.forEach(derivative => visit(derivative, 0));
  if (statuses.some(value => !KNOWN_STATUSES.has(value))) return { status, outcome: 'review', errorCode: 'unknown_derivative_status' };
  if (statuses.some(value => value === 'failed' || value === 'timeout')) return { status, outcome: 'failed', errorCode: 'requested_derivative_failed' };
  if (statuses.some(value => value !== 'success')) return { status, outcome: 'waiting', errorCode: null };
  return { status, outcome: 'ready', errorCode: null };
}

export class ApsModelDerivativeAdapter {
  readonly #config: ApsProviderConfig;
  private readonly transport: typeof fetch;
  private readonly store: ApsCheckpointStore;
  private readonly now: () => Date;
  #token: { value: string; expiresAt: number } | null = null;

  constructor(config: ApsProviderConfig, transport: typeof fetch, store: ApsCheckpointStore, now: () => Date = () => new Date()) {
    this.#config = { ...config }; this.transport = transport; this.store = store; this.now = now;
    for (const value of [config.pollIntervalMs ?? 30_000, config.requestTimeoutMs ?? 30_000]) {
      if (!Number.isSafeInteger(value) || value < 1_000 || value > 300_000) throw new ApsProviderError('invalid_timing_configuration');
    }
  }

  async start(input: { runId: string; sourceFormat: string; objectId: string }): Promise<ApsTranslationCheckpoint> {
    assertAuthorized(this.#config);
    // Routing is explicit even though APS can render PDFs. PDF takeoff is not an APS translation.
    if (!NATIVE_FORMATS.has(input.sourceFormat)) throw new ApsProviderError('native_cad_bim_required');
    if (!input.runId.trim() || !/^urn:adsk\.objects:os\.object:[^/\s]+\/[^\r\n]+$/.test(input.objectId)
      || input.objectId.length > 2_048 || /\.pdf$/i.test(input.objectId)) throw new ApsProviderError('invalid_source_object');
    const sourceUrn = Buffer.from(input.objectId, 'utf8').toString('base64url');
    const existing = await this.store.load(input.runId);
    if (existing) return this.existing(existing, sourceUrn, input.sourceFormat);
    const checkpoint: ApsTranslationCheckpoint = {
      version: 'aps-adapter-v1', runId: input.runId, sourceFormat: input.sourceFormat as ApsNativeFormat,
      sourceUrn, outputType: 'svf2', state: 'submitting', providerStatus: null, pollAttempts: 0, nextPollAt: null, errorCode: null,
    };
    if (!await this.store.claimInitial(checkpoint)) {
      const claimed = await this.store.load(input.runId);
      if (!claimed) throw new ApsProviderError('persistence_conflict');
      return this.existing(claimed, sourceUrn, input.sourceFormat);
    }
    let token: string;
    try { token = await this.accessToken(); }
    catch (error) { return this.persist({ ...checkpoint, state: 'failed', errorCode: error instanceof ApsProviderError ? error.code : 'oauth_unavailable' }); }
    let response: Response;
    try {
      response = await this.request('/modelderivative/v2/designdata/job', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-ads-force': 'false' },
        body: JSON.stringify({ input: { urn: sourceUrn }, output: { formats: [{ type: 'svf2', views: ['2d', '3d'] }] } }),
      });
    } catch { return this.persist({ ...checkpoint, state: 'submission_uncertain', errorCode: 'submission_outcome_unknown' }); }
    if (response.status === 200 || response.status === 201) return this.persist({ ...checkpoint, state: 'awaiting_manifest', nextPollAt: this.now().toISOString() });
    const uncertain = response.status >= 500 || (response.status >= 300 && response.status < 400);
    return this.persist({ ...checkpoint, state: uncertain ? 'submission_uncertain' : 'failed', errorCode: `translation_http_${response.status}` });
  }

  async poll(runId: string): Promise<ApsTranslationCheckpoint> {
    assertAuthorized(this.#config);
    const checkpoint = await this.store.load(runId);
    if (!checkpoint) throw new ApsProviderError('checkpoint_not_found');
    if (checkpoint.state === 'submitting') return this.persist({ ...checkpoint, state: 'submission_uncertain', errorCode: 'submission_outcome_unknown' });
    if (checkpoint.state !== 'awaiting_manifest') return checkpoint;
    if (checkpoint.nextPollAt && Date.parse(checkpoint.nextPollAt) > this.now().getTime()) return checkpoint;
    const attempted = { ...checkpoint, pollAttempts: checkpoint.pollAttempts + 1 };
    let token: string;
    try { token = await this.accessToken(); }
    catch (error) {
      if (error instanceof ApsProviderError && /^oauth_http_(?:400|401|403)$/.test(error.code)) {
        return this.persist({ ...attempted, state: 'failed', nextPollAt: null, errorCode: error.code });
      }
      return this.schedule(attempted, error instanceof ApsProviderError ? error.code : 'oauth_unavailable', undefined,
        error instanceof ApsProviderError ? error.retryAfter : null);
    }
    let response: Response;
    try { response = await this.request(`/modelderivative/v2/designdata/${encodeURIComponent(checkpoint.sourceUrn)}/manifest`, {
      method: 'GET', headers: { Authorization: `Bearer ${token}` },
    }); }
    catch { return this.schedule(attempted, 'poll_transport_unavailable'); }
    if (response.status === 429 || response.status >= 500) return this.schedule(attempted, `poll_http_${response.status}`, response);
    if (!response.ok) return this.persist({ ...attempted, state: 'failed', nextPollAt: null, errorCode: `poll_http_${response.status}` });
    let payload: unknown;
    try { payload = await this.json(response); }
    catch { return this.persist({ ...attempted, state: 'review_required', nextPollAt: null, errorCode: 'invalid_response' }); }
    let result: ReturnType<typeof inspectApsManifest>;
    try { result = inspectApsManifest(payload, checkpoint.sourceUrn); }
    catch (error) {
      if (!(error instanceof ApsProviderError)) throw error;
      return this.persist({ ...attempted, state: 'review_required', nextPollAt: null, errorCode: error.code });
    }
    const updated = { ...attempted, providerStatus: result.status, errorCode: result.errorCode };
    if (result.outcome === 'waiting') return this.schedule(updated, null);
    return this.persist({ ...updated, nextPollAt: null,
      state: result.outcome === 'ready' ? 'translation_ready' : result.outcome === 'failed' ? 'failed' : 'review_required' });
  }

  private existing(checkpoint: ApsTranslationCheckpoint, sourceUrn: string, sourceFormat: string): ApsTranslationCheckpoint {
    if (checkpoint.sourceUrn !== sourceUrn || checkpoint.sourceFormat !== sourceFormat) throw new ApsProviderError('run_input_conflict');
    return checkpoint;
  }
  private request(path: string, init: RequestInit): Promise<Response> {
    return this.transport(new URL(path, BASE_URL), { ...init, redirect: 'manual',
      headers: { ...init.headers, Accept: 'application/json' }, signal: AbortSignal.timeout(this.#config.requestTimeoutMs ?? 30_000) });
  }
  private async json(response: Response): Promise<unknown> {
    const text = await response.text();
    if (Buffer.byteLength(text) > 4_000_000) throw new ApsProviderError('response_too_large');
    return JSON.parse(text) as unknown;
  }
  private async accessToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt > this.now().getTime()) return this.#token.value;
    const response = await this.request('/authentication/v2/token', {
      method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${this.#config.clientId}:${this.#config.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read data:write data:create' }).toString(),
    });
    if (!response.ok) throw new ApsProviderError(`oauth_http_${response.status}`, response.headers.get('retry-after'));
    const body = record(await this.json(response));
    if (body.token_type !== 'Bearer' || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in)
      || body.expires_in <= 0 || body.expires_in > 86_400) throw new ApsProviderError('invalid_oauth_response');
    const value = requiredString(body.access_token);
    this.#token = { value, expiresAt: this.now().getTime() + Math.max(0, body.expires_in - 60) * 1_000 };
    return value;
  }
  private schedule(checkpoint: ApsTranslationCheckpoint, errorCode: string | null, response?: Response, retryAfter?: string | null): Promise<ApsTranslationCheckpoint> {
    const retryHeader = retryAfter ?? response?.headers.get('retry-after');
    const seconds = retryHeader && /^\d+(?:\.\d+)?$/.test(retryHeader) ? Number(retryHeader) : null;
    const dateDelay = retryHeader && seconds === null ? Date.parse(retryHeader) - this.now().getTime() : 0;
    const delay = Math.max(this.#config.pollIntervalMs ?? 30_000, seconds === null ? (Number.isFinite(dateDelay) ? dateDelay : 0) : seconds * 1_000);
    if (!Number.isFinite(delay) || delay > 7 * 86_400_000) return this.persist({ ...checkpoint, state: 'review_required', nextPollAt: null, errorCode: 'retry_window_unverified' });
    return this.persist({ ...checkpoint, errorCode, nextPollAt: new Date(this.now().getTime() + delay).toISOString() });
  }
  private async persist(checkpoint: ApsTranslationCheckpoint): Promise<ApsTranslationCheckpoint> {
    await this.store.save(checkpoint);
    return checkpoint;
  }
}
