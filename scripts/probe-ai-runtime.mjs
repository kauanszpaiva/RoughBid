/** Read-only deployment diagnostic. Never sends a plan, generates tokens, or logs credentials. */
const KNOWN_REASONS = new Set([
  'API_KEY_INVALID', 'API_KEY_EXPIRED', 'API_KEY_SERVICE_BLOCKED',
  'API_KEY_HTTP_REFERRER_BLOCKED', 'API_KEY_IP_ADDRESS_BLOCKED',
  'SERVICE_DISABLED', 'BILLING_DISABLED', 'CONSUMER_INVALID',
  'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'RATE_LIMIT_EXCEEDED',
]);

export async function probeAiRuntime(env = process.env, fetcher = fetch) {
  if (env.PAID_PLAN_READINGS_ENABLED !== 'true') return { status: 'disabled' };
  const key = env.GEMINI_API_KEY?.trim();
  const model = env.GEMINI_MODEL?.trim();
  if (!key || /masked|redacted|placeholder|changeme|^\[|^</i.test(key)
      || !model || !/^gemini-[a-z0-9][a-z0-9._-]{1,78}$/i.test(model)) {
    return { status: 'unconfigured', code: 'PROVIDER_CONFIGURATION' };
  }
  try {
    const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${model}`, {
      method: 'GET', headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.supportedGenerationMethods?.includes('generateContent')) {
      return { status: 'available', model, httpStatus: response.status, code: 'OK' };
    }
    const reason = body.error?.details?.find(value => KNOWN_REASONS.has(value?.reason))?.reason;
    const code = reason || (response.status === 404 ? 'MODEL_UNAVAILABLE'
      : response.status === 429 ? 'PROVIDER_QUOTA'
      : response.status === 401 || response.status === 403 ? 'PROVIDER_ACCESS_DENIED'
      : response.ok ? 'GENERATION_NOT_SUPPORTED' : 'PROVIDER_REJECTED');
    return { status: 'unavailable', model, httpStatus: response.status, code };
  } catch (error) {
    return { status: 'unavailable', model, code: error?.name === 'TimeoutError' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK' };
  }
}
