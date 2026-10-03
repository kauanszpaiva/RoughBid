// Configuration inventory only. Values from credential fields never leave
// the server; no inference, account mutation or token-generation call occurs.
const configured = value => typeof value === 'string' && value.trim().length > 8
  && !/masked|redacted|placeholder|changeme|^\[|^</i.test(value.trim());
const model = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9._:/-]{1,100}$/.test(value)
  && !/^(sk|rk|whsec|AIza|sb_secret)[_-]/.test(value) ? value : null;
const integer = (env, key, maximum) => /^\d{1,8}$/.test(env[key] ?? '') && Number(env[key]) <= maximum ? Number(env[key]) : null;
export function probeProviderInventory(env = process.env) {
  return {
    credentials: Object.fromEntries(['GEMINI_API_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY','KIMI_API_KEY',
      'DEEPSEEK_API_KEY','KAMAI_API_KEY','APS_CLIENT_ID','APS_CLIENT_SECRET'].map(key=>[key,configured(env[key])])),
    models: Object.fromEntries(['GEMINI_MODEL','OPENAI_MODEL','KIMI_MODEL','DEEPSEEK_MODEL'].map(key=>[key,model(env[key])])),
    enabled: Object.fromEntries(['PAID_FULL_ENABLED','PHOTO_TAKEOFF_ENABLED','PHOTO_TAKEOFF_WORKER_ENABLED',
      'GEOMETRY_PROVIDER_ENABLED','GEOMETRY_PROVIDER_SPEND_APPROVED','TAKEOFF_V2_KAMAI_ENABLED',
      'OPENAI_PLAN_READING_ENABLED','KIMI_PLAN_READING_ENABLED','DEEPSEEK_PLAN_READING_ENABLED'].map(key=>[key,env[key]==='true'])),
    pricing: Object.fromEntries(['PROJECT_PAYMENT_FIXED_CENTS','PROJECT_PAYMENT_FEE_BPS',
      'PROJECT_COST_BASE_CENTS','PROJECT_COST_PAGE_CENTS','PROJECT_COST_TRADE_CENTS'].map(key=>[key,integer(env,key,1_000_000)])),
    providerCalls: 0,
    credentialsAuthenticated: false,
  };
}
