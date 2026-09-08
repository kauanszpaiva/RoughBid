import { ProjectApiError } from '../projects/service.ts';
import { systemPrompt, type GeminiGenerateContentClient, type GeminiPlanReadInput } from './gemini.ts';
import { sanitizePlanReadingResult, type PlanReadingResult } from './types.ts';
import { isConfiguredValue } from './readiness.ts';

// Pinned pricing and a single request: no model fallback, tools, caching or retries.
// https://ai.google.dev/gemini-api/docs/pricing (verified 2026-09-08)
export const PILOT_MODEL = 'gemini-2.5-flash';
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
    const counted = await this.client.countTokens!({ model: PILOT_MODEL, contents, config: { httpOptions: { timeout: 30_000, retryOptions: { attempts: 1 } } } });
    if (!Number.isSafeInteger(counted.totalTokens) || counted.totalTokens! < 1 || counted.totalTokens! > PILOT_MAX_INPUT_TOKENS) {
      throw new ProjectApiError(413, 'This PDF exceeds the pilot analysis size. Use a smaller, simpler plan.');
    }
    // $0.30/M input + $2.50/M output = <= $0.01984, below the $0.25 reserve.
    const response = await this.client.generateContent({ model: PILOT_MODEL, contents, config: {
      responseMimeType: 'application/json', temperature: 0.1,
      maxOutputTokens: PILOT_MAX_OUTPUT_TOKENS, thinkingConfig: { thinkingBudget: 0 },
      httpOptions: { timeout: 60_000, retryOptions: { attempts: 1 } },
    } });
    const result = sanitizePlanReadingResult(JSON.parse(response.text || '{}'));
    if (!result.findings.length) throw new Error('No usable pilot findings were returned. The attempt remains counted to protect the pilot budget.');
    const usage = (response as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } }).usageMetadata;
    return { ...result, summary: { ...result.summary, pilot_usage: {
      model: PILOT_MODEL, counted_input_tokens: counted.totalTokens!, reserved_cents: PILOT_RESERVATION_CENTS,
      ...(usage ? { provider_usage: usage } : {}),
    } } };
  }
}
