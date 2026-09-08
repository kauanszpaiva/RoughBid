import { isConfiguredValue } from './readiness.ts';
import { ProjectApiError } from '../projects/service.ts';

export const FREE_PROVIDER_UNCONFIGURED =
  'The free owner analysis route is not configured. No provider was contacted.';

/**
 * Credentials for the owner-only free route.
 *
 * This deliberately reads its OWN variables and never falls back to
 * GEMINI_API_KEY / GEMINI_MODEL: the paid project is prepay Tier 1, so reusing
 * its key here would bill real money for a route sold as free. A missing or
 * placeholder value fails closed BEFORE any provider call is made.
 */
export function requireFreeProviderConfig(env: Record<string, string | undefined>) {
  if (env.FREE_PROVIDER_ENABLED !== 'true') throw new ProjectApiError(503, FREE_PROVIDER_UNCONFIGURED);
  const apiKey = env.GEMINI_FREE_API_KEY?.trim();
  const model = env.GEMINI_FREE_MODEL?.trim();
  const project = env.GEMINI_FREE_PROJECT_ID?.trim();
  if (!isConfiguredValue(apiKey) || !isConfiguredValue(model) || !isConfiguredValue(project)) {
    throw new ProjectApiError(503, FREE_PROVIDER_UNCONFIGURED);
  }
  if (!/^gemini-[a-z0-9][a-z0-9._-]+$/i.test(model)) throw new ProjectApiError(503, FREE_PROVIDER_UNCONFIGURED);
  // The operator must assert the project is the verified non-billed one. Without
  // this the route stays closed even when a key is present.
  if (env.GEMINI_FREE_TIER_VERIFIED !== 'true') throw new ProjectApiError(503, FREE_PROVIDER_UNCONFIGURED);
  if (apiKey === env.GEMINI_API_KEY?.trim()) {
    throw new ProjectApiError(503, 'The free route must not reuse the billed provider credential.');
  }
  return { apiKey, model, project };
}

/** True only when the free route is fully configured; never throws. */
export function isFreeProviderConfigured(env: Record<string, string | undefined>): boolean {
  try { requireFreeProviderConfig(env); return true; } catch { return false; }
}
