import { isConfiguredValue } from './readiness.ts';

/**
 * Explicit, single-workspace free entitlement for the product owner's own
 * workspace. This never grants a customer workspace a reading: customers keep
 * the confirmed-payment requirement in `reserve_project_reading`.
 *
 * Both the feature flag and the exact workspace id must be configured, and the
 * id must match the caller's workspace exactly. Absent or placeholder config
 * yields no entitlement, so the closed-by-default posture is preserved.
 */
export function isFreeOwnerWorkspace(workspaceId: string, env: Record<string, string | undefined>): boolean {
  if (env.FREE_OWNER_READINGS_ENABLED !== 'true') return false;
  const allowed = env.FREE_OWNER_WORKSPACE_ID?.trim();
  if (!isConfiguredValue(allowed) || !isUuid(allowed)) return false;
  const caller = workspaceId?.trim();
  if (!caller || !isUuid(caller)) return false;
  return timingSafeEqualString(caller.toLowerCase(), allowed.toLowerCase());
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** Constant-time compare so a workspace id cannot be probed byte by byte. */
function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The free path must never silently fall back to a paid provider. Callers use
 * this to assert that the reader selected for a free reading is a free one.
 */
export function assertNoPaidFallback(readerName: string): void {
  if (readerName !== 'openrouter/free' && readerName !== 'gemini-free-tier') {
    throw new Error(`Free owner reading refused: provider "${readerName}" is not a verified free-tier route.`);
  }
}
