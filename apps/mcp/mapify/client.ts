export type MapifyClientOptions = {
  apiKey: string;
  baseUrl: string;
  fetcher?: typeof fetch;
};

export class MapifyApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'MapifyApiError';
    this.status = status;
  }
}

/** Server-side Mapify client. The API key is deliberately never returned to MCP callers. */
export class MapifyClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: MapifyClientOptions) {
    if (!options.apiKey.trim()) throw new Error('MAPIFY_API_KEY is required');
    const url = new URL(options.baseUrl);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      throw new Error('MAPIFY_API_BASE_URL must use HTTPS');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.fetcher = options.fetcher ?? fetch;
  }

  requestMeasurements(input: { address: string; externalProjectId?: string }) {
    return this.request('/v1/buildings/measurements', { method: 'POST', body: JSON.stringify(input) });
  }

  getBlueprint(buildingId: string, format: 'pdf' | 'svg' | 'dxf' = 'pdf') {
    return this.request(`/v1/buildings/${encodeURIComponent(buildingId)}/blueprint?format=${format}`);
  }

  getJob(jobId: string) {
    return this.request(`/v1/jobs/${encodeURIComponent(jobId)}`);
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json', 'content-type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json().catch(() => null) as { message?: unknown } | null;
    if (!response.ok) {
      const detail = typeof payload?.message === 'string' ? `: ${payload.message}` : '';
      throw new MapifyApiError(response.status, `Mapify request failed (${response.status})${detail}`);
    }
    return payload;
  }
}
