import { ProjectApiError } from '../projects/service.ts';
import { systemPrompt, type GeminiGenerateContentClient, type GeminiPlanReadInput } from './gemini.ts';
import { sanitizePlanReadingResult, type PlanReadingResult } from './types.ts';
import { isConfiguredValue } from './readiness.ts';
import { runProviderOperation } from './provider-errors.ts';

// Pinned pricing and a single request: no model fallback, tools, caching or retries.
// Gemini 3.8 Flash GA pricing verified 2026-09-09 against the official Gemini API pricing page:
// $0.75/M input + $3.75/M output through 2026-12-31. With this pilot envelope
// (32k input + 4,096 output), the theoretical maximum is $0.03936 per analysis,
// comfortably below the conservative $0.25 reservation made before provider work.
export const PILOT_MODEL = 'gemini-3.8-flash';
export const PILOT_MAX_INPUT_TOKENS = 32_000;
export const PILOT_MAX_OUTPUT_TOKENS = 4_096;
export const PILOT_RESERVATION_CENTS = 25;
export const PILOT_PRICE_REVIEW_BEFORE = '2026-12-01T00:00:00Z';
export const PILOT_MAX_PDF_BYTES = 10 * 1024 * 1024;
export const PILOT_MAX_PAGES = 10;

export function requirePilotReaderConfig(env: Record<string, string | undefined>, now = Date.now()) {
  const apiKey = env.GEMINI_PILOT_API_KEY?.trim() || env.GEMINI_API_KEY?.trim();
  if (env.PILOT_READINGS_ENABLED !== 'true' || !isConfiguredValue(apiKey) || now >= Date.parse(PILOT_PRICE_REVIEW_BEFORE)) {
    throw new ProjectApiError(503, 'Pilot AI is unavailable until its budget and provider configuration are verified.');
  }
  return { apiKey, model: PILOT_MODEL };
}

/** Called only AFTER the database permanently reserves 25 cents for this project. */
export class PilotPlanReader {
  private client: GeminiGenerateContentClient;
  constructor(client: GeminiGenerateContentClient) { this.client = client; }
  assertReady() {
    if (!this.client.countTokens || Date.now() >= Date.parse(PILOT_PRICE_REVIEW_BEFORE)) {
      throw new ProjectApiError(503, 'Pilot token accounting needs verification before another analysis.');
    }
  }
  async read(input: GeminiPlanReadInput): Promise<PlanReadingResult> {
    this.assertReady();
    if (input.fileBytes.length > PILOT_MAX_PDF_BYTES) throw new ProjectApiError(413, 'Pilot PDFs must be 10 MB or smaller.');
    const instruction = systemPrompt(input.sheetName.slice(0, 255), input.requestedTrades);
    // Count the complete prompt including instructions; never estimate PDF tokens from bytes/pages.
    const contents = [{ role: 'user', parts: [
      { text: `${instruction}\nRead the attached plan. Project scope: ${(input.scope || '').slice(0, 500)}` },
      { inlineData: { mimeType: 'application/pdf', data: Buffer.from(input.fileBytes).toString('base64') } },
    ] }];
    const counted = await runProviderOperation('gemini',PILOT_MODEL,'count_tokens',()=>this.client.countTokens!({ model: PILOT_MODEL, contents, config: { httpOptions: { timeout: 30_000, retryOptions: { attempts: 1 } } } }));
    if (!Number.isSafeInteger(counted.totalTokens) || counted.totalTokens! < 1 || counted.totalTokens! > PILOT_MAX_INPUT_TOKENS) {
      throw new ProjectApiError(413, 'This PDF exceeds the pilot analysis size. Use a smaller, simpler plan.');
    }
    const response = await runProviderOperation('gemini',PILOT_MODEL,'generate',()=>this.client.generateContent({ model: PILOT_MODEL, contents, config: {
      responseMimeType: 'application/json',
      maxOutputTokens: PILOT_MAX_OUTPUT_TOKENS,
      thinkingConfig: { thinkingLevel: 'LOW' },
      httpOptions: { timeout: 60_000, retryOptions: { attempts: 1 } },
    } }));
    const parsed = await runProviderOperation('gemini',PILOT_MODEL,'parse',async()=>JSON.parse(response.text || '{}'));
    const result = sanitizePlanReadingResult(parsed);
    if (!result.findings.length) throw new Error('No usable pilot findings were returned. The attempt remains counted to protect the pilot budget.');
    const usage = (response as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } }).usageMetadata;
    return { ...result, summary: { ...result.summary, pilot_usage: {
      model: PILOT_MODEL, counted_input_tokens: counted.totalTokens!, reserved_cents: PILOT_RESERVATION_CENTS,
      ...(usage ? { provider_usage: usage } : {}),
    } } };
  }
}