import canonicalize from 'canonicalize';
import { requireStageDeepPassConfig, type StageDeepPassConfig } from '../takeoff-v2/stage-config.ts';
import { BRIDGE_PATH, BridgeError } from './protocol.ts';
import { bridgeSha256, type BridgeAuthConfig } from './auth.ts';
import { BRIDGE_RENDER_POLICY } from './renderer.ts';

export const BRIDGE_PROBE_ID = '00000000-0000-0000-0000-000000000000';
export const BRIDGE_RESPONSE_HEADER = 'x-rb-bridge-response-signature';
export const BRIDGE_PROFILE_HEADER = 'x-rb-bridge-profile';
export const BRIDGE_TEMPLATE_VERSION = 'full-evidence-v1';
export const BRIDGE_RESERVATION_CAPABILITY='reviewed-operation-reservations-v1';
export function bridgeCanonical(value: unknown): string {
  const result = canonicalize(value); if (typeof result !== 'string') throw new BridgeError('bridge_identity_conflict', 409); return result;
}
export const bridgeObjectHash = (value: unknown): string => bridgeSha256(bridgeCanonical(value));
export function publicBridgeProfile(config: StageDeepPassConfig) {
  return {version:'full-stage-bridge-v1',template_version:BRIDGE_TEMPLATE_VERSION,requestTimeoutMs:config.requestTimeoutMs,
    regionalReview:config.regionalReview,renderer:BRIDGE_RENDER_POLICY,stages:Object.fromEntries(Object.entries(config.stages).map(([pass,stage])=>[pass,{
      provider:stage.provider,model:stage.model,reasoningEffort:stage.reasoningEffort,maxOutputTokens:stage.maxOutputTokens,
      ...(stage.requestPolicy?{requestPolicy:stage.requestPolicy}:{}),
      attestation:stage.attestation,...(stage.baseUrl?{baseUrl:stage.baseUrl}:{})}]))};
}
export interface BridgeRuntimeConfig { auth:BridgeAuthConfig; endpoint:string; stages:StageDeepPassConfig; profile:ReturnType<typeof publicBridgeProfile>; profileHash:string }
export function requireBridgeConnectionConfig(env:Record<string,string|undefined>):{auth:BridgeAuthConfig;endpoint:string}{
  if(env.PROVIDER_BRIDGE_ENABLED!=='true') throw new BridgeError('bridge_adapter_unavailable',503);
  const secret=env.SUPABASE_SERVICE_ROLE_KEY?.trim(),context=env.PROVIDER_BRIDGE_AUTH_CONTEXT?.trim();
  let url:URL;try{url=new URL(env.PROVIDER_BRIDGE_URL??'');}catch{throw new BridgeError('bridge_auth_unconfigured',503);}
  if(!secret||secret.includes('[SENSITIVE]')||!context||url.protocol!=='https:'||url.username||url.password||url.search||url.hash
    ||url.pathname!==BRIDGE_PATH)throw new BridgeError('bridge_auth_unconfigured',503);
  return {auth:{existingSecret:Buffer.from(secret),trustedEnvironmentContext:context,canonicalize:bridgeCanonical,maxSkewSeconds:90},endpoint:url.href};
}
export function requireBridgeRuntimeConfig(env:Record<string,string|undefined>, side:'worker'|'server'):BridgeRuntimeConfig {
  const connection=requireBridgeConnectionConfig(env),stages=requireStageDeepPassConfig(env,side==='server'?'required':'optional');
  // Leaves room for private materialization and durable finalization in the 300s function.
  if(stages.requestTimeoutMs>180_000)throw new BridgeError('bridge_adapter_unavailable',503);
  const profile=publicBridgeProfile(stages);
  return {...connection,stages,profile,profileHash:bridgeObjectHash(profile)};
}
