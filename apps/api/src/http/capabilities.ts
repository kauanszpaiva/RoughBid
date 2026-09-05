import { isConfiguredValue, requirePaidPlanReadingConfig } from '../ai-plan/readiness.ts';
import { quoteProject } from '../billing/project-preflight.ts';
import { loadObjectStorageConfig } from '../storage/object-storage.ts';

/** Configuration flags only; this never probes a provider or reveals credentials. */
export function runtimeCapabilities(env: Record<string, string | undefined>) {
  let aiReadingAvailable = false;
  let billing = false;
  try {
    requirePaidPlanReadingConfig(env);
    if (!isConfiguredValue(env.SUPABASE_URL) || !isConfiguredValue(env.SUPABASE_PUBLISHABLE_KEY) || !isConfiguredValue(env.SUPABASE_SERVICE_ROLE_KEY?.trim() || env.SUPABASE_PLAN_FUNCTION?.trim())) {
      return { aiReadingAvailable, billing };
    }
    new URL(env.SUPABASE_URL);
    if (!isConfiguredValue(env.BLOB_READ_WRITE_TOKEN)) {
      const storage = loadObjectStorageConfig(env);
      if (![storage.endpoint, storage.bucket, storage.accessKeyId, storage.secretAccessKey].every(isConfiguredValue)) return { aiReadingAvailable, billing };
    }
    aiReadingAvailable = true;
    const key = env.STRIPE_SECRET_KEY?.trim() || '';
    const live = env.STRIPE_MODE === 'live';
    if (!isConfiguredValue(key) || !key.startsWith(live ? 'sk_live_' : 'sk_test_') || !isConfiguredValue(env.STRIPE_WEBHOOK_SECRET) || !isConfiguredValue(env.APP_URL) || new URL(env.APP_URL).protocol !== 'https:') {
      return { aiReadingAvailable, billing };
    }
    quoteProject(1, 1, 'standard', env);
    billing = true;
  } catch {
    // Optional paid features remain unavailable until all their prerequisites exist.
  }
  return { aiReadingAvailable, billing };
}
