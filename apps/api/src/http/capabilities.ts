import { isConfiguredValue, requirePaidPlanReadingConfig } from '../ai-plan/readiness.ts';
import { quoteProject } from '../billing/project-preflight.ts';
import { loadObjectStorageConfig } from '../storage/object-storage.ts';

/** Configuration flags only; this never probes a provider or reveals credentials. */
export function runtimeCapabilities(env: Record<string, string | undefined>) {
  const flags = { aiReadingAvailable: false, billing: false, membershipStarter: false, membershipPro: false, membershipTeam: false, billingPortal: false, marketplaceSupplierImport: false };
  // Free owner entitlement is deliberately NOT reported here. This endpoint is
  // public and env-only, so a global flag would advertise "free analysis" to
  // every customer workspace. Entitlement is per-workspace and is answered by
  // the authenticated GET /api/projects/:id/ai-plan-entitlement route instead.
  try {
    if (!isConfiguredValue(env.SUPABASE_URL) || !isConfiguredValue(env.SUPABASE_PUBLISHABLE_KEY) || !isConfiguredValue(env.SUPABASE_SERVICE_ROLE_KEY?.trim() || env.SUPABASE_PLAN_FUNCTION?.trim())) {
      return flags;
    }
    new URL(env.SUPABASE_URL);
    const key = env.STRIPE_SECRET_KEY?.trim() || '';
    const live = env.STRIPE_MODE === 'live';
    const stripeReady = isConfiguredValue(key) && key.startsWith(live ? 'sk_live_' : 'sk_test_')
      && isConfiguredValue(env.STRIPE_WEBHOOK_SECRET) && isConfiguredValue(env.APP_URL) && new URL(env.APP_URL).protocol === 'https:';
    flags.billingPortal = stripeReady;
    flags.marketplaceSupplierImport = stripeReady && env.BILLING_MARKETPLACE_ENABLED==='true'
      && isConfiguredValue(env.STRIPE_PRICE_MARKETPLACE_SUPPLIER_IMPORT)
      && /^price_[a-zA-Z0-9]+$/.test(env.STRIPE_PRICE_MARKETPLACE_SUPPLIER_IMPORT!);
    if (stripeReady && env.BILLING_MEMBERSHIPS_ENABLED === 'true') {
      const priceReady = (value: string | undefined) => isConfiguredValue(value) && /^price_[a-zA-Z0-9]+$/.test(value);
      flags.membershipStarter = priceReady(env.STRIPE_PRICE_PLAN_STARTER);
      flags.membershipPro = priceReady(env.STRIPE_PRICE_PLAN_PRO);
      flags.membershipTeam = priceReady(env.STRIPE_PRICE_PLAN_TEAM);
    }
    if (!isConfiguredValue(env.BLOB_READ_WRITE_TOKEN)) {
      const storage = loadObjectStorageConfig(env);
      if (![storage.endpoint, storage.bucket, storage.accessKeyId, storage.secretAccessKey].every(isConfiguredValue)) return flags;
    }
    let hasPaidProvider = false;
    try { requirePaidPlanReadingConfig(env); hasPaidProvider = true; } catch { /* Billing-gated provider is optional. */ }
    flags.aiReadingAvailable = hasPaidProvider;
    if (!flags.aiReadingAvailable || !stripeReady) return flags;
    quoteProject(1, 1, 'standard', env);
    flags.billing = true;
  } catch {
    // Optional paid features remain unavailable until all their prerequisites exist.
  }
  return flags;
}
