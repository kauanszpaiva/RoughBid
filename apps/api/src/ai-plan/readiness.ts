import { ProjectApiError } from '../projects/service.ts';

export const PLAN_READING_UNAVAILABLE = 'AI plan reading is currently unavailable. You can continue with manual quantities and export your proposal.';

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
