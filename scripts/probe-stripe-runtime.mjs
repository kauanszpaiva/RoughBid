// Read-only runtime verification. Never return provider bodies, headers or secrets.
export async function probeStripeRuntime(env = process.env, fetcher = fetch) {
  const key = env.STRIPE_SECRET_KEY?.trim();
  const expected = env.STRIPE_EXPECTED_ACCOUNT_ID;
  const configuredMode = env.STRIPE_MODE === 'live' ? 'live' : env.STRIPE_MODE === 'test' ? 'test' : 'unconfigured';
  const credentialMode = /^(?:sk|rk)_live_[A-Za-z0-9]+$/.test(key ?? '') ? 'live'
    : /^(?:sk|rk)_test_[A-Za-z0-9]+$/.test(key ?? '') ? 'test' : 'unconfigured';
  const base = { configuredMode, credentialMode, expectedAccountConfigured: /^acct_[A-Za-z0-9]+$/.test(expected ?? ''),
    webhookConfigured: /^whsec_[A-Za-z0-9]+$/.test(env.STRIPE_WEBHOOK_SECRET ?? '') };
  if (credentialMode === 'unconfigured') return { ...base, status: 'credential_missing_or_invalid_format' };
  const read = async path => {
    try {
      const r = await fetcher(`https://api.stripe.com/v1/${path}`, { method: 'GET', redirect: 'error',
        signal: AbortSignal.timeout(12000), headers: { authorization: `Bearer ${key}`, 'Stripe-Version': '2026-08-26.dahlia' } });
      const data = await r.json();
      return { status: r.status, data };
    } catch { return { status: 0, data: null }; }
  };
  const account = await read('account');
  if (account.status !== 200) return { ...base, status: account.status === 401 ? 'credential_rejected'
    : account.status === 403 ? 'account_read_not_permitted' : 'stripe_unavailable', httpStatus: account.status };
  const accountMatches = base.expectedAccountConfigured && account.data?.id === expected;
  const sessions = await read('checkout/sessions?limit=1');
  const checkoutRead = sessions.status === 200 && sessions.data?.object === 'list';
  return { ...base, accountMatches, chargesEnabled: account.data?.charges_enabled === true,
    checkoutRead, checkoutHttpStatus: sessions.status,
    status: !accountMatches ? 'account_not_verified' : configuredMode !== credentialMode ? 'mode_mismatch'
      : !checkoutRead ? 'checkout_read_not_permitted' : 'verified_read_only',
    // Listing cannot certify write permission or the webhook signing-secret pair.
    checkoutWriteVerified: false, signedWebhookVerified: false };
}
