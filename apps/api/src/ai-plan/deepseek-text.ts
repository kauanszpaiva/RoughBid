import { meterOpenAiCompatibleCall, UsageAccountingError } from '../owner-usage/meter.ts';
import { ProjectApiError } from '../projects/service.ts';
import { AiProviderError, classifyProviderFailure } from './provider-errors.ts';
import { isConfiguredValue } from './readiness.ts';
import { requireImageProviderBaseUrl } from './vision-capabilities.ts';

export interface DeepSeekTextAttestation {
  accountVerified: true;
  compatibilityVerified: true;
  maximumCallCostUsd: number;
}
export interface DeepSeekTextProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: 'deepseek-v4-pro';
  timeoutMs: number;
  maxOutputTokens: number;
  attestation: DeepSeekTextAttestation;
}
export interface DeepSeekTextJsonInput {
  /** Previously extracted, source-backed evidence only; never an image/PDF content block. */
  prompt: string;
  systemPrompt: string;
  reasoningEffort?: 'low' | 'high' | 'max';
}
const MAX_TEXT_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_RESPONSE_BYTES = 4 * 1024 * 1024;
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function boundedConfigValue(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ProjectApiError(503, 'DeepSeek text request bounds are not configured correctly.');
  }
  return parsed;
}
/** No credential lookup or model downgrade. Operator verification is required separately from key presence. */
export function requireDeepSeekTextConfig(env: Record<string, string | undefined>,
  attestation: DeepSeekTextAttestation): DeepSeekTextProviderConfig {
  if (env.DEEPSEEK_TEXT_READING_ENABLED !== 'true') throw new ProjectApiError(503, 'DeepSeek text processing is disabled.');
  if (env.DEEPSEEK_PRIVATE_PLAN_DATA_APPROVED !== 'true') throw new ProjectApiError(503, 'DeepSeek private-plan processing is not approved.');
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!isConfiguredValue(apiKey) || env.DEEPSEEK_TEXT_MODEL?.trim() !== 'deepseek-v4-pro') {
    throw new ProjectApiError(503, 'DeepSeek text processing requires explicit DEEPSEEK_TEXT_MODEL=deepseek-v4-pro and a manually configured credential.');
  }
  const config: DeepSeekTextProviderConfig = {
    apiKey, model: 'deepseek-v4-pro',
    baseUrl: requireImageProviderBaseUrl('deepseek', env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com'),
    timeoutMs: boundedConfigValue(env.AI_PLAN_DEEPSEEK_TEXT_TIMEOUT_MS, 120_000, 1_000, 900_000),
    maxOutputTokens: boundedConfigValue(env.AI_PLAN_DEEPSEEK_TEXT_MAX_OUTPUT_TOKENS, 16_000, 1, 64_000),
    attestation,
  };
  assertTextConfig(config);
  return config;
}
function assertTextConfig(config: DeepSeekTextProviderConfig): void {
  if (!isConfiguredValue(config.apiKey) || config.model !== 'deepseek-v4-pro'
    || config.attestation?.accountVerified !== true || config.attestation?.compatibilityVerified !== true
    || !Number.isFinite(config.attestation.maximumCallCostUsd) || config.attestation.maximumCallCostUsd <= 0
    || config.attestation.maximumCallCostUsd > 100_000
    || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1_000 || config.timeoutMs > 900_000
    || !Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens < 1 || config.maxOutputTokens > 64_000) {
    throw new ProjectApiError(503, 'DeepSeek Pro text processing requires account/compatibility verification and reviewed bounded spend.');
  }
  requireImageProviderBaseUrl('deepseek', config.baseUrl);
}
async function boundedResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new SyntaxError('Missing provider response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_TEXT_RESPONSE_BYTES) {
        await reader.cancel();
        throw new SyntaxError('Provider response exceeded its bound.');
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!record(parsed)) throw new SyntaxError('Provider response is not an object.');
  return parsed;
}

/** Pro is a separate text transport. It cannot be passed to the rendered-image reader. */
export class DeepSeekTextJsonProvider {
  private readonly config: DeepSeekTextProviderConfig;
  private readonly fetcher: typeof fetch;
  constructor(config: DeepSeekTextProviderConfig, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }

  async generate(input: DeepSeekTextJsonInput): Promise<Record<string, unknown>> {
    assertTextConfig(this.config);
    if (!record(input) || Object.keys(input).some(key => !['prompt', 'systemPrompt', 'reasoningEffort'].includes(key))
      || typeof input.prompt !== 'string' || !input.prompt.trim()
      || typeof input.systemPrompt !== 'string' || !input.systemPrompt.trim()
      || (input.reasoningEffort !== undefined && !['low', 'high', 'max'].includes(input.reasoningEffort))) {
      throw new ProjectApiError(422, 'DeepSeek Pro accepts text evidence and an explicit text instruction only. No provider request was sent.');
    }
    const body = JSON.stringify({
      model: this.config.model,
      messages: [{ role: 'system', content: `${input.systemPrompt}\nReturn one JSON object only.` },
        { role: 'user', content: input.prompt }],
      max_tokens: this.config.maxOutputTokens,
      thinking: { type: 'enabled' }, reasoning_effort: input.reasoningEffort ?? 'high',
      response_format: { type: 'json_object' }, stream: false,
    });
    if (Buffer.byteLength(body, 'utf8') > MAX_TEXT_REQUEST_BYTES) {
      throw new ProjectApiError(413, 'DeepSeek text evidence exceeds this request bound. No provider request was sent.');
    }
    const started = Date.now();
    let response: Record<string, unknown>;
    try {
      response = await meterOpenAiCompatibleCall('deepseek', this.config.model, async () => {
        const http = await this.fetcher(`${this.config.baseUrl}/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey}` },
          body, signal: AbortSignal.timeout(this.config.timeoutMs), redirect: 'error',
        });
        if (!http.ok) throw Object.assign(new Error('Configured text provider request was rejected.'), { status: http.status });
        return await boundedResponse(http);
      }, { minimumReservationUsd: this.config.attestation.maximumCallCostUsd });
    } catch (error) {
      if (error instanceof UsageAccountingError || error instanceof ProjectApiError) throw error;
      throw classifyProviderFailure(error, { provider: 'deepseek', model: this.config.model,
        stage: 'generate', durationMs: Date.now() - started });
    }
    const choices = response.choices;
    const choice = Array.isArray(choices) && choices.length === 1 && record(choices[0]) ? choices[0] : null;
    const message = choice && record(choice.message) ? choice.message : null;
    const diagnostic = { provider: 'deepseek' as const, model: this.config.model, stage: 'parse' as const, durationMs: Date.now() - started };
    if (choice?.finish_reason === 'length') throw new AiProviderError('provider_output_truncated', diagnostic);
    if (choice?.finish_reason !== 'stop' || typeof message?.content !== 'string' || !message.content.trim()) {
      throw new AiProviderError('provider_invalid_output', diagnostic);
    }
    try {
      // Reasoning is neither logged nor returned; only the final JSON evidence is exposed.
      const result: unknown = JSON.parse(message.content);
      if (!record(result)) throw new SyntaxError('Expected JSON object.');
      return result;
    } catch { throw new AiProviderError('provider_invalid_output', diagnostic); }
  }
}
