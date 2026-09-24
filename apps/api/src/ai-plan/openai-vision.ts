import { ProjectApiError } from '../projects/service.ts';
import { meterOpenAiCompatibleCall, type MeteredVisionProvider, UsageAccountingError } from '../owner-usage/meter.ts';
import { sanitizePlanReadingResult, type PlanReadingResult } from './types.ts';
import { MAX_INLINE_PLAN_BYTES, type GeminiPlanReadInput, systemPrompt } from './gemini.ts';
import { describePlanEvidenceDigest } from './sheet-text.ts';
import { AiProviderError, classifyProviderFailure, logProviderFailure } from './provider-errors.ts';
import { isConfiguredValue } from './readiness.ts';

export interface OpenAiVisionProviderConfig {
  provider: MeteredVisionProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxImages: number;
}

const DEFAULT_MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function safeHttpsBaseUrl(value: string, allowedHosts: readonly string[]): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !allowedHosts.includes(url.hostname)) {
    throw new ProjectApiError(503, 'AI provider endpoint is not an approved HTTPS host.');
  }
  return url.toString().replace(/\/$/, '');
}

function maxImagesFromEnv(env: Record<string, string | undefined>): number {
  const parsed = Number(env.LOW_COST_VISION_MAX_PAGES);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 16 ? parsed : DEFAULT_MAX_IMAGES;
}

export function requireDeepSeekVisionConfig(env: Record<string, string | undefined>): OpenAiVisionProviderConfig {
  if (env.DEEPSEEK_PLAN_READING_ENABLED !== 'true') throw new ProjectApiError(503, 'DeepSeek plan reading is disabled.');
  if (env.DEEPSEEK_PRIVATE_PLAN_DATA_APPROVED !== 'true') {
    throw new ProjectApiError(503, 'DeepSeek private-plan processing is not approved.');
  }
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  const model = env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash';
  if (!isConfiguredValue(apiKey) || !/^deepseek-[a-z0-9][a-z0-9._-]+$/i.test(model)) {
    throw new ProjectApiError(503, 'DeepSeek plan reading is not configured.');
  }
  return {
    provider: 'deepseek',
    apiKey,
    baseUrl: safeHttpsBaseUrl(env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com', ['api.deepseek.com']),
    model,
    maxImages: maxImagesFromEnv(env),
  };
}

export function requireKimiVisionConfig(env: Record<string, string | undefined>): OpenAiVisionProviderConfig {
  if (env.KIMI_PLAN_READING_ENABLED !== 'true') throw new ProjectApiError(503, 'Kimi plan reading is disabled.');
  const apiKey = env.KIMI_API_KEY?.trim();
  // K2.6 is the default cost-optimized vision fallback. K3 can still be selected explicitly.
  const model = env.KIMI_MODEL?.trim() || 'kimi-k2.6';
  const baseUrl = env.KIMI_BASE_URL?.trim();
  if (!isConfiguredValue(apiKey) || !isConfiguredValue(baseUrl) || !/^kimi-[a-z0-9][a-z0-9._-]+$/i.test(model)) {
    throw new ProjectApiError(503, 'Kimi plan reading is not configured.');
  }
  return {
    provider: 'kimi',
    apiKey,
    baseUrl: safeHttpsBaseUrl(baseUrl, ['api.moonshot.ai', 'api.moonshot.cn']),
    model,
    maxImages: maxImagesFromEnv(env),
  };
}

export function requireOpenAiVisionConfig(env: Record<string, string | undefined>): OpenAiVisionProviderConfig {
  if (env.OPENAI_PLAN_READING_ENABLED !== 'true') throw new ProjectApiError(503, 'OpenAI plan reading is disabled.');
  const apiKey = env.OPENAI_API_KEY?.trim();
  const model = env.OPENAI_MODEL?.trim() || 'gpt-4.1';
  if (!isConfiguredValue(apiKey) || !/^(?:gpt|o[0-9])[a-z0-9._-]*$/i.test(model)) {
    throw new ProjectApiError(503, 'OpenAI plan reading is not configured.');
  }
  return {
    provider: 'openai',
    apiKey,
    baseUrl: safeHttpsBaseUrl(env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1', ['api.openai.com']),
    model,
    maxImages: maxImagesFromEnv(env),
  };
}

export function configuredProviderOrder(env: Record<string, string | undefined>): Array<'claude' | 'deepseek' | 'gemini' | 'kimi' | 'openai'> {
  const allowed = new Set(['claude', 'deepseek', 'gemini', 'kimi', 'openai']);
  const raw = (env.AI_PLAN_PROVIDER_ORDER || 'gemini,claude,openai,kimi,deepseek')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const unique = [...new Set(raw.filter(value => allowed.has(value)))] as Array<'claude' | 'deepseek' | 'gemini' | 'kimi' | 'openai'>;
  for (const provider of ['gemini', 'claude', 'openai', 'kimi', 'deepseek'] as const) if (!unique.includes(provider)) unique.push(provider);
  return unique;
}

function userPrompt(input: GeminiPlanReadInput): string {
  const source = input.pageImages?.length
    ? 'The images are ordered and individually labeled with their physical PDF page numbers.'
    : 'The attached document is the complete construction plan; report the physical page number of every finding.';
  return `Read this construction drawing set for takeoff preparation.
Return JSON only. Every quantity must cite a visible physical page and verbatim source excerpt.
Do not estimate prices or infer hidden dimensions. If the drawing is ambiguous, return a risk/question instead.
Locate rooms, walls, outlines and symbols from what is actually drawn on the sheet, not from typical layouts.
Project scope: ${input.scope || 'not supplied'}.
Requested trades: ${input.requestedTrades.join(', ') || 'all visible trades'}.
${source}`;
}

type ChatCompletionResponse = {
  id?: string;
  choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export class OpenAiCompatibleVisionPlanReader {
  private readonly config: OpenAiVisionProviderConfig;
  private readonly fetcher: typeof fetch;

  constructor(config: OpenAiVisionProviderConfig, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }

  assertReady(): void {
    if (!this.config.apiKey || !this.config.model || !this.config.baseUrl) throw new ProjectApiError(503, 'AI vision provider is not configured.');
  }

  async read(input: GeminiPlanReadInput): Promise<PlanReadingResult> {
      this.assertReady();
    const images = (input.pageImages || []).slice(0, this.config.maxImages);
    // OpenAI reads construction PDFs natively, so it needs no renderer; the
    // image-native low-cost providers still fail closed without page images.
    const attachesPdf = this.config.provider === 'openai';
    if (!images.length && !attachesPdf) {
      throw new ProjectApiError(503, `${this.config.provider} requires server-rendered plan page images. No provider request was sent.`);
    }
    if (!images.length && input.fileBytes.byteLength > MAX_INLINE_PLAN_BYTES) {
      throw new ProjectApiError(413, 'This plan is too large to attach as a document. No provider request was sent.');
    }
    if (images.some(image => image.bytes.byteLength < 1 || image.bytes.byteLength > MAX_IMAGE_BYTES)) {
      throw new ProjectApiError(413, 'A rendered plan page is outside the low-cost vision size limit. No provider request was sent.');
    }

    const evidenceDigest = describePlanEvidenceDigest({ linework: input.linework, sheetText: input.sheetText });
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: userPrompt(input) }];
    if (evidenceDigest) content.push({ type: 'text', text: evidenceDigest });
    if (!images.length) {
      content.push({
        type: 'file',
        file: { filename: 'construction-plan.pdf', file_data: `data:${input.mimeType};base64,${Buffer.from(input.fileBytes).toString('base64')}` },
      });
    }
    for (const image of images) {
      content.push({ type: 'text', text: `Physical PDF page ${image.pageNumber}:` });
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString('base64')}`,
          ...(this.config.provider === 'deepseek' ? { detail: 'original' } : this.config.provider === 'openai' ? { detail: 'high' } : {}),
        },
      });
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        { role: 'system', content: systemPrompt(input.sheetName, input.requestedTrades) },
        { role: 'user', content },
      ],
      response_format: { type: 'json_object' },
      stream: false,
      ...(this.config.provider === 'deepseek'
        ? { max_tokens: 8000, thinking: { type: input.reasoningEffort === 'high' ? 'enabled' : 'disabled' },
            reasoning_effort: input.reasoningEffort === 'high' ? 'high' : 'none' }
        : {
            max_completion_tokens: 8000,
            ...(this.config.model.startsWith('kimi-k3')
              ? { reasoning_effort: input.reasoningEffort === 'high' ? 'high' : 'low' }
              : {}),
          }),
    };

    const started = Date.now();
    let response: ChatCompletionResponse;
    try {
      response = await meterOpenAiCompatibleCall(this.config.provider, this.config.model, async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60_000);
        try {
          const http = await this.fetcher(`${this.config.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey}` },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          if (!http.ok) {
            const error = Object.assign(new Error('provider_http_error'), { status: http.status });
            throw error;
          }
          return await http.json() as ChatCompletionResponse;
        } finally { clearTimeout(timeout); }
      });
    } catch (error) {
      if (error instanceof UsageAccountingError || error instanceof ProjectApiError) throw error;
      const failure = classifyProviderFailure(error, {
        provider: this.config.provider,
        model: this.config.model,
        stage: 'generate',
        durationMs: Date.now() - started,
      });
      logProviderFailure(failure);
      throw failure;
    }

    const choice = response.choices?.[0];
    if (choice?.finish_reason === 'length') {
      const failure = new AiProviderError('provider_output_truncated', {
        provider: this.config.provider, model: this.config.model, stage: 'parse', durationMs: Date.now() - started,
      });
      logProviderFailure(failure);
      throw failure;
    }

    try {
      const parsed = JSON.parse(choice?.message?.content || '{}');
      const result = sanitizePlanReadingResult(parsed);
      if (!result.findings.length) throw new Error('empty');
      return result;
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      const failure = classifyProviderFailure(error, {
        provider: this.config.provider, model: this.config.model, stage: 'parse', durationMs: Date.now() - started,
      }, 'provider_invalid_output');
      logProviderFailure(failure);
      throw failure;
    }
  }
}
