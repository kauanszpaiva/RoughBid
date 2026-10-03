export const consentTestEnv = {
  TAKEOFF_V2_ENABLED: 'true', TAKEOFF_V2_WORKER_ENABLED: 'true', TAKEOFF_V2_STAGE_PROVIDER_ENABLED: 'true',
  TAKEOFF_V2_SCHEMA_VERSION: 'takeoff-v2-foundation-v1', TAKEOFF_V2_STAGE_CLASSIFICATION_ENABLED: 'true',
  TAKEOFF_V2_STAGE_CLASSIFICATION_PROVIDER: 'gemini', TAKEOFF_V2_STAGE_CLASSIFICATION_MODEL: 'gemini-3.8-flash',
  GEMINI_API_KEY: 'unit-gemini-credential',
  TAKEOFF_V2_CALL_RESERVATION_USD: '0.25',
  TAKEOFF_V2_MODEL_ATTESTATIONS_JSON: JSON.stringify({ 'gemini-3.8-flash': { accountVerified: true, compatibilityVerified: true, priceVersion: 'unit-fixture-only', maximumCallCostUsd: 0.25 } }),
  TAKEOFF_V2_RUN_SPEND_LIMITS_JSON: JSON.stringify({ gemini: { approvedUsd: 3, maximumCalls: 12, approvalRef: 'unit-fixture-ceiling' } }),
};
