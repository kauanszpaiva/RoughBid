import { ProjectApiError } from '../projects/service.ts';
import { TEXT_ONLY_READING_REFUSED, type PlanReaderVisualCapability } from './types.ts';

export const PLAN_READING_UNAVAILABLE = 'AI plan reading is currently unavailable. You can continue with manual quantities and export your proposal.';

/**
 * A plan reading must inspect the drawing itself (line work, symbols, icons,
 * hatching, graphic scale), not only extracted PDF text. A reader that declares
 * `text_only` is refused before any reservation, download or provider call.
 * `AI_PLAN_ALLOW_TEXT_ONLY_READING=true` is the only way to override it, for an
 * explicitly disclosed text-only benchmark.
 */
export function assertReaderInspectsDrawing(
  reader: { visualCapability?: PlanReaderVisualCapability } | undefined,
  env: Record<string, string | undefined> = process.env,
): void {
  if (reader?.visualCapability !== 'text_only') return;
  if (env.AI_PLAN_ALLOW_TEXT_ONLY_READING === 'true') return;
  throw new ProjectApiError(503, TEXT_ONLY_READING_REFUSED);
}

/** Deployment previews can contain masked values; those are never credentials. */
export function isConfiguredValue(value: string | undefined): value is string {
  if (!value?.trim()) return false;
  const text = value.trim();
  return !/^(?:\[.*\]|<.*>|\$\{.*\}|\*{2,}|undefined|null)$/i.test(text)
    && !/(?:^|[-_ ])(?:sensitive|redacted|placeholder|changeme|fake|example|default|unmeasured)(?:$|[-_ ])/i.test(text)
    && !/^(?:your[-_ ]|replace[-_ ]|configured[-_ ])/i.test(text);
}

/** Explicit operator opt-in; having an API key alone never opens paid checkout. */
export function requirePaidPlanReadingConfig(env: Record<string, string | undefined>) {
  const apiKey = env.GEMINI_API_KEY?.trim();
  const model = env.GEMINI_MODEL?.trim();
  if (env.PAID_PLAN_READINGS_ENABLED !== 'true' || !isConfiguredValue(apiKey) || !isConfiguredValue(model) || !/^gemini-[a-z0-9][a-z0-9._-]+$/i.test(model)) {
    throw new ProjectApiError(503, PLAN_READING_UNAVAILABLE);
  }
  return { apiKey, model };
}
