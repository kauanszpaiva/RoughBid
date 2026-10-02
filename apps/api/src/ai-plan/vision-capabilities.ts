import { ProjectApiError } from '../projects/service.ts';

export type RenderedVisionProvider = 'kimi' | 'deepseek';
/** Public contracts checked on 2026-10-02; this does not attest account access. */
export const RENDERED_VISION_MODELS = Object.freeze({
  'kimi-k3': { provider: 'kimi', documentation: 'https://platform.kimi.ai/docs/guide/kimi-k3-quickstart' },
  'kimi-k2.6': { provider: 'kimi', documentation: 'https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart' },
  'deepseek-flash': { provider: 'deepseek', documentation: 'https://api-docs.deepseek.com/guides/vision/' },
} as const);

export function requireRenderedVisionModel(provider: RenderedVisionProvider, model: string): keyof typeof RENDERED_VISION_MODELS {
  if (provider === 'deepseek' && model === 'deepseek-v4-pro') {
    throw new ProjectApiError(503, 'DeepSeek Pro accepts text only. Configure DEEPSEEK_TEXT_MODEL for a text stage; plan images require deepseek-flash. No provider request was sent.');
  }
  if (!Object.hasOwn(RENDERED_VISION_MODELS, model)
    || RENDERED_VISION_MODELS[model as keyof typeof RENDERED_VISION_MODELS].provider !== provider) {
    throw new ProjectApiError(503, `${provider} requires an explicitly configured, verified vision model. No provider request was sent.`);
  }
  return model as keyof typeof RENDERED_VISION_MODELS;
}

/** Region is chosen manually. Credentials in URLs, redirects and arbitrary paths are never accepted. */
export function requireImageProviderBaseUrl(provider: RenderedVisionProvider, value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ProjectApiError(503, 'AI provider endpoint is not an approved HTTPS host and API path.'); }
  const allowedHosts = provider === 'kimi' ? ['api.moonshot.ai', 'api.moonshot.cn'] : ['api.deepseek.com'];
  const path = url.pathname.replace(/\/$/, '');
  const expectedPath = provider === 'kimi' ? '/v1' : '';
  if (url.protocol !== 'https:' || !allowedHosts.includes(url.hostname) || path !== expectedPath
    || url.port || url.username || url.password || url.search || url.hash) {
    throw new ProjectApiError(503, 'AI provider endpoint is not an approved HTTPS host and API path.');
  }
  return `${url.origin}${path}`;
}

/** Single-turn only: no discarded reasoning history or tool-call loop. */
export function renderedVisionGenerationOptions(provider: RenderedVisionProvider, model: string,
  maxOutputTokens: number, effort: 'low' | 'high' = 'low'): Record<string, unknown> {
  requireRenderedVisionModel(provider, model);
  const limit = Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : 16_000;
  if (model === 'kimi-k3') return { max_completion_tokens: limit, reasoning_effort: effort };
  // K2.6 uses max_tokens and a thinking toggle; K3 always thinks and has a different contract.
  if (provider === 'kimi') return { max_tokens: limit, thinking: { type: effort === 'high' ? 'enabled' : 'disabled' } };
  return { max_tokens: limit, thinking: { type: effort === 'high' ? 'enabled' : 'disabled' },
    ...(effort === 'high' ? { reasoning_effort: 'high' } : {}) };
}

/** Check the serialized body, including base64 expansion and prompt, before reserving spend. */
export function assertRenderedVisionRequestSize(provider: RenderedVisionProvider, serialized: string): void {
  // DeepSeek documents 48 MiB; Moonshot documents 100M. Keep Kimi below 100 decimal MB.
  const maximum = provider === 'deepseek' ? 48 * 1024 * 1024 : 100_000_000;
  if (Buffer.byteLength(serialized, 'utf8') > maximum) {
    throw new ProjectApiError(413, `${provider} rendered-page request exceeds its inline body limit. No provider request was sent.`);
  }
}
