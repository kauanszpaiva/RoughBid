import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

export const GEMINI_PROFILE = Object.freeze({
  model: 'gemini-3.8-flash', inputTokenLimit: 1048576, outputTokenLimit: 65536,
  maximumCallCostUsd: 2.50, documentedTokenCostUpperBoundUsd: 1.04,
  priceVersion: 'google-standard-20261002-with-existing-db-reserve-2.50',
  validUntil: '2027-01-01T00:00:00.000Z',
  pricingSource: 'https://ai.google.dev/gemini-api/docs/pricing#gemini-3.8-flash',
  modelSource: 'https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash',
});
export const OPTIONAL_CREDENTIAL_NAMES = Object.freeze(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'KIMI_API_KEY', 'DEEPSEEK_API_KEY', 'KAMAI_API_KEY', 'APS_CLIENT_ID', 'APS_CLIENT_SECRET']);
export function reviewedActivationProfile() {
  const profile = {
    TAKEOFF_V2_ENABLED: 'true', TAKEOFF_V2_WORKER_ENABLED: 'true', TAKEOFF_V2_SCHEMA_VERSION: 'takeoff-v2-foundation-v1',
    TAKEOFF_V2_STAGE_PROVIDER_ENABLED: 'true', TAKEOFF_V2_CALL_RESERVATION_USD: '2.5',
    TAKEOFF_V2_REGIONAL_REVIEW_ENABLED: 'true', TAKEOFF_V2_REGION_GRID: '2',
    TAKEOFF_V2_MODEL_ATTESTATIONS_JSON: JSON.stringify({ [GEMINI_PROFILE.model]: { accountVerified: true, compatibilityVerified: true,
      priceVersion: GEMINI_PROFILE.priceVersion, maximumCallCostUsd: GEMINI_PROFILE.maximumCallCostUsd } }),
    TAKEOFF_V2_RUN_SPEND_LIMITS_JSON: JSON.stringify({ gemini: { approvedUsd: 5, maximumCalls: 100,
      approvalRef: 'roughbid-pilot-technical-ceiling-20261003-user-consent-required' } }),
    AI_PLAN_DURABLE_ENABLED: 'false', PHOTO_TAKEOFF_ENABLED: 'false', PHOTO_TAKEOFF_WORKER_ENABLED: 'false',
    GEOMETRY_PROVIDER_ENABLED: 'false', GEOMETRY_PROVIDER_SPEND_APPROVED: 'false',
    TAKEOFF_V2_KAMAI_ENABLED: 'false', TAKEOFF_V2_APS_ENABLED: 'false',
    ROUGH_BID_LIVE_TESTS_ENABLED: 'false', ROUGH_BID_LIVE_TEST_SPEND_APPROVED: 'false',
  };
  for (const stage of ['CLASSIFICATION', 'LEGENDS_SCHEDULES', 'DISCIPLINE', 'RECONCILIATION', 'CONFLICT_DETECTION', 'COMPLETENESS', 'RISK_REVIEW']) {
    Object.assign(profile, { [`TAKEOFF_V2_STAGE_${stage}_ENABLED`]: 'true', [`TAKEOFF_V2_STAGE_${stage}_PROVIDER`]: 'gemini',
      [`TAKEOFF_V2_STAGE_${stage}_MODEL`]: GEMINI_PROFILE.model, [`TAKEOFF_V2_STAGE_${stage}_REASONING_EFFORT`]: 'high',
      [`TAKEOFF_V2_STAGE_${stage}_MAX_OUTPUT_TOKENS`]: '64000' });
  }
  for (const stage of ['GEOMETRY', 'ARITHMETIC_QA', 'PRICING_ASSEMBLIES']) profile[`TAKEOFF_V2_STAGE_${stage}_ENABLED`] = 'false';
  return profile;
}
function requireCredential(value, name) {
  const minimumLength = name === 'APS_CLIENT_ID' ? 8 : 20;
  if (typeof value !== 'string' || value.includes('[SENSITIVE]') || value.length < minimumLength || value.length > 8192 || !/^[A-Za-z0-9_.~+/=-]+$/.test(value)) {
    throw new Error(`Invalid or masked credential: ${name}`);
  }
  return value;
}
export function encodeDotenv(values) {
  return Object.entries(values).map(([key, value]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('Unsupported configuration entry');
    const encoded = /^[A-Za-z0-9_.:/=@+-]*$/.test(value) ? value : !value.includes("'") ? `'${value}'` : !value.includes('"') ? `"${value}"` : null;
    if (encoded === null || parseEnv(`${key}=${encoded}`)[key] !== value) throw new Error('Configuration value cannot be encoded safely');
    return `${key}=${encoded}`;
  }).join('\n') + '\n';
}
export async function verifyCredentials(input, config, fetcher = fetch) {
  const serviceKey = requireCredential(input.supabaseServiceRoleKey, 'SUPABASE_SERVICE_ROLE_KEY');
  const geminiKey = requireCredential(input.geminiApiKey, 'GEMINI_API_KEY');
  if (config.supabaseHost !== 'piasgpciojstjalaqazu.supabase.co') throw new Error('Unexpected Supabase target');
  if (Date.now() >= Date.parse(GEMINI_PROFILE.validUntil)) throw new Error('Reviewed Gemini pricing profile has expired');
  const schema = await fetcher(`https://${config.supabaseHost}/rest/v1/rpc/full_takeoff_stage_schema_ready`, {
    method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: '{}', signal: AbortSignal.timeout(15000),
  });
  if (!schema.ok || await schema.json() !== true) throw new Error('Supabase credential or activated schema could not be verified');
  const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_PROFILE.model}`, {
    method: 'GET', headers: { 'x-goog-api-key': geminiKey }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Gemini exact-model metadata verification failed (HTTP ${response.status})`);
  const metadata = await response.json();
  if (metadata.name !== `models/${GEMINI_PROFILE.model}` || !metadata.supportedGenerationMethods?.includes('generateContent')
      || !Number.isSafeInteger(metadata.inputTokenLimit) || metadata.inputTokenLimit < 1 || metadata.inputTokenLimit > GEMINI_PROFILE.inputTokenLimit
      || !Number.isSafeInteger(metadata.outputTokenLimit) || metadata.outputTokenLimit < 4096 || metadata.outputTokenLimit > GEMINI_PROFILE.outputTokenLimit) {
    throw new Error('Gemini model metadata differs from the reviewed capabilities and cost bound');
  }
  return { serviceKey, geminiKey, checkedAt: new Date().toISOString(), model: metadata.name,
    inputTokenLimit: metadata.inputTokenLimit, outputTokenLimit: metadata.outputTokenLimit };
}
async function main() {
  const configPath = resolve(process.argv[2]);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  let inputText = '';
  let input;
  if (process.argv[3] === '--credentials-file') {
    const credentialsPath = resolve(process.argv[4] || '');
    if (!config.credentialsFile || credentialsPath !== resolve(config.credentialsFile)) throw new Error('Unexpected credential input file');
    const fields = parseEnv(readFileSync(credentialsPath, 'utf8'));
    const allowed = new Set(['SUPABASE_SERVICE_ROLE_KEY', 'GEMINI_API_KEY', ...OPTIONAL_CREDENTIAL_NAMES]);
    if (Object.keys(fields).some(key => !allowed.has(key))) throw new Error('Unexpected credential field in input file');
    const optionalCredentials = {};
    for (const key of OPTIONAL_CREDENTIAL_NAMES) {
      if (fields[key]?.trim()) optionalCredentials[key] = requireCredential(fields[key].trim(), key);
    }
    input = { supabaseServiceRoleKey: fields.SUPABASE_SERVICE_ROLE_KEY?.trim(), geminiApiKey: fields.GEMINI_API_KEY?.trim(), optionalCredentials };
  } else {
    for await (const chunk of process.stdin) {
      inputText += chunk;
      if (inputText.length > 20000) throw new Error('Credential input too large');
    }
    input = JSON.parse(inputText);
  }
  const checked = await verifyCredentials(input, config);
  inputText = '';
  const envPath = config.envFiles.at(-1);
  if (!envPath || !envPath.endsWith('worker.override.env')) throw new Error('Unexpected protected worker configuration file');
  const values = parseEnv(readFileSync(envPath, 'utf8'));
  Object.assign(values, {
    SUPABASE_URL: `https://${config.supabaseHost}`, SUPABASE_SERVICE_ROLE_KEY: checked.serviceKey, GEMINI_API_KEY: checked.geminiKey,
    GEMINI_MODEL: GEMINI_PROFILE.model, ROUGH_BID_LIVE_TESTS_ENABLED: 'false', ROUGH_BID_LIVE_TEST_SPEND_APPROVED: 'false',
    ROUGH_BID_PILOT_PROFILE_VALID_UNTIL: GEMINI_PROFILE.validUntil,
  });
  for (const [key, value] of Object.entries(input.optionalCredentials || {})) {
    if (!OPTIONAL_CREDENTIAL_NAMES.includes(key)) throw new Error('Unexpected optional credential field');
    values[key] = requireCredential(value, key);
  }
  // These flags prepare the real worker after metadata/schema validation. The
  // controller remains paused until Start; every run still requires the user's
  // explicit in-product budget. Optional credentials do not activate providers.
  Object.assign(values, reviewedActivationProfile());
  const temp = `${envPath}.tmp`;
  writeFileSync(temp, encodeDotenv(values)); renameSync(temp, envPath);
  const evidence = { checkedAt: checked.checkedAt, supabaseProject: config.supabaseHost,
    schemaReady: true, modelMetadataVerified: checked.model,
    inputTokenLimit: checked.inputTokenLimit, outputTokenLimit: checked.outputTokenLimit,
    costProfile: GEMINI_PROFILE, providerInferenceTested: false, documentsUploaded: false, secretsWrittenToProtectedConfig: true,
    optionalCredentialsStored: Object.keys(input.optionalCredentials || {}), optionalProvidersActivated: false,
    compatibilityEvidence: 'Official model documentation plus offline provider adapter tests; no live inference.' };
  writeFileSync(resolve(config.stateDirectory, 'credential-verification.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ configured: true, schemaReady: true, modelMetadataVerified: checked.model,
    providerInferenceTested: false, documentsUploaded: false, workerStarted: false }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Only controlled validation messages are public; transport diagnostics can
    // contain URLs or headers and are deliberately reduced to an error category.
    const message = error instanceof Error && /^(Invalid or masked|Unexpected|Reviewed Gemini|Supabase credential|Gemini exact-model|Gemini model|Credential input|Unsupported configuration|Configuration value)/.test(error.message)
      ? error.message : 'Credential validation could not complete; check network and target account.';
    console.error(JSON.stringify({ configured: false, message })); process.exitCode = 1;
  });
}
