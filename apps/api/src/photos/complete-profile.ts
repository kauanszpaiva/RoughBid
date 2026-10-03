import { createHash } from 'node:crypto';
import { ProjectApiError } from '../projects/service.ts';
import { PHOTO_EVIDENCE_STAGES, requirePhotoEvidenceProfile, type PhotoEvidenceStage, type PhotoStageRoute } from '../photo-evidence/profile.ts';
import { STAGE_REASONING_CAPABILITIES, type StageReasoningEffort } from '../takeoff-v2/stage-config.ts';
import type { PhotoSourceAsset } from '../photo-evidence.ts';
import { maximumTokenCostUsd } from '../billing/provider-cost-bound.ts';

export const PHOTO_COMPLETE_VERSION = 'photo-complete-v1';
export const PHOTO_EXECUTION_POLICY = 'one-durable-photo-run-budget-wait-no-uncertain-replay';
export type PhotoOperation = { key: string; stage: PhotoEvidenceStage; assetIds: string[];reservationUsd?:number };
export interface CompletePhotoRoute extends PhotoStageRoute {
  reasoningEffort: StageReasoningEffort; maxOutputTokens: number; timeoutMs: number;
  requestPolicy?:{serviceTier:'default';promptCacheMode:'explicit'};
  tariff: { inputUsdPerMillion: number; outputUsdPerMillion: number; inputTokenLimit: number; outputTokenLimit: number;
    combinedContextTokenLimit?:number;standardUncached:true;reasoningIncluded:true;maximumAcceptedInput:true;additionalRequestUsd: number; source: string; verifiedAt: string; expiresAt: string };
}
export interface CompletePhotoProfile { version: typeof PHOTO_COMPLETE_VERSION; profileHash: string;
  routes: Record<PhotoEvidenceStage, CompletePhotoRoute>; expiresAt: string; maximumContextBytes: number }
export function photoCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(photoCanonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0)
    .map(([k,v])=>`${JSON.stringify(k)}:${photoCanonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const photoHash = (value: unknown) => createHash('sha256').update(photoCanonical(value)).digest('hex');
const unavailable = (): never => { throw new ProjectApiError(503, 'Complete photo reading is not configured. Please contact support. No payment was started.'); };
const positive = (n: unknown): n is number => typeof n==='number'&&Number.isFinite(n)&&n>0;
/** Explicit reviewed tariff snapshot; neither credits nor a model name attests pricing. */
export function requireCompletePhotoProfile(env: Record<string,string|undefined>, now=Date.now()): CompletePhotoProfile {
  if(env.PHOTO_COMPLETE_ENABLED!=='true'||env.PRIVATE_PHOTO_DATA_APPROVED!=='true')return unavailable();
  let raw:any;try{if(!env.PHOTO_COMPLETE_PROFILE_JSON||env.PHOTO_COMPLETE_PROFILE_JSON.length>32768)return unavailable();raw=JSON.parse(env.PHOTO_COMPLETE_PROFILE_JSON);}catch{return unavailable();}
  if(raw?.version!==PHOTO_COMPLETE_VERSION||!Number.isSafeInteger(raw.maximumContextBytes)||raw.maximumContextBytes<4096||raw.maximumContextBytes>1_000_000)return unavailable();
  try{requirePhotoEvidenceProfile({enabled:true,quality:'maximum',routes:raw.routes});}catch{return unavailable();}
  const routes={} as Record<PhotoEvidenceStage,CompletePhotoRoute>;
  for(const stage of PHOTO_EVIDENCE_STAGES){
    const r=raw.routes[stage],t=r.tariff,caps=STAGE_REASONING_CAPABILITIES[r.model as CompletePhotoRoute['model']];
    if(!t||t.standardUncached!==true||t.reasoningIncluded!==true||t.maximumAcceptedInput!==true||!positive(t.inputUsdPerMillion)||!positive(t.outputUsdPerMillion)||!Number.isSafeInteger(t.inputTokenLimit)||t.inputTokenLimit<1
      ||!Number.isSafeInteger(t.outputTokenLimit)||t.outputTokenLimit<4096||typeof t.additionalRequestUsd!=='number'||!Number.isFinite(t.additionalRequestUsd)||t.additionalRequestUsd<0
      ||r.reasoningEffort!==caps.maximum||!Number.isSafeInteger(r.maxOutputTokens)||r.maxOutputTokens<caps.outputDefault||r.maxOutputTokens>caps.outputCeiling||r.maxOutputTokens>t.outputTokenLimit
      ||!Number.isSafeInteger(r.timeoutMs)||r.timeoutMs<1000||r.timeoutMs>600000||!Number.isFinite(Date.parse(t.verifiedAt))||Date.parse(t.verifiedAt)>now
      ||!Number.isFinite(Date.parse(t.expiresAt))||Date.parse(t.expiresAt)<=now)return unavailable();
    if(r.model==='gpt-6-astra'&&(r.requestPolicy?.serviceTier!=='default'||r.requestPolicy?.promptCacheMode!=='explicit'))return unavailable();
    let source:URL;try{source=new URL(t.source);}catch{return unavailable();}
    const domains=r.provider==='gemini'?['ai.google.dev','cloud.google.com']:r.provider==='openai'?['openai.com','platform.openai.com','developers.openai.com']:['anthropic.com','docs.anthropic.com','platform.claude.com'];
    if(source.protocol!=='https:'||source.username||source.password||!domains.includes(source.hostname))return unavailable();
    let bound:number;try{bound=maximumTokenCostUsd(t);}catch{return unavailable();}
    if(!positive(bound)||!positive(r.maximumCallCostUsd)||!Number.isSafeInteger(Math.round(r.maximumCallCostUsd*1e6))
      ||Math.abs(r.maximumCallCostUsd*1e6-Math.round(r.maximumCallCostUsd*1e6))>=.000001||r.maximumCallCostUsd<bound)return unavailable();
    routes[stage]={provider:r.provider,model:r.model,accountVerified:true,imageCompatibilityVerified:true,priceVersion:r.priceVersion,maximumCallCostUsd:r.maximumCallCostUsd,
      reasoningEffort:r.reasoningEffort,maxOutputTokens:r.maxOutputTokens,timeoutMs:r.timeoutMs,...(r.model==='gpt-6-astra'?{requestPolicy:{serviceTier:'default' as const,promptCacheMode:'explicit' as const}}:{}),
      tariff:{inputUsdPerMillion:t.inputUsdPerMillion,outputUsdPerMillion:t.outputUsdPerMillion,inputTokenLimit:t.inputTokenLimit,outputTokenLimit:t.outputTokenLimit,
        ...(t.combinedContextTokenLimit===undefined?{}:{combinedContextTokenLimit:t.combinedContextTokenLimit}),standardUncached:true,reasoningIncluded:true,maximumAcceptedInput:true,additionalRequestUsd:t.additionalRequestUsd,source:source.href,verifiedAt:t.verifiedAt,expiresAt:t.expiresAt}};
  }
  const base:Omit<CompletePhotoProfile,'profileHash'>={version:PHOTO_COMPLETE_VERSION,routes,expiresAt:new Date(Math.min(...Object.values(routes).map(r=>Date.parse(r.tariff.expiresAt)))).toISOString(),maximumContextBytes:raw.maximumContextBytes};
  return {...base,profileHash:photoHash(base)};
}
/** Every view, every cross-view pair and a separate risk pass; no sampled photos. */
export function planCompletePhotoOperations(assets:readonly PhotoSourceAsset[],profile?:CompletePhotoProfile,baseReservation?:number):PhotoOperation[]{
  if(!assets.length||assets.length>8||new Set(assets.map(a=>a.id)).size!==assets.length)throw new ProjectApiError(400,'Select one to eight different photos.');
  const ids=assets.map(a=>a.id).sort(),operations:PhotoOperation[]=ids.map(id=>({key:`observation:${id}`,stage:'observation',assetIds:[id]}));
  if(ids.length===1)operations.push({key:`reconciliation:${ids[0]}`,stage:'reconciliation',assetIds:[ids[0]!]});
  else for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++)operations.push({key:`reconciliation:${ids[i]}:${ids[j]}`,stage:'reconciliation',assetIds:[ids[i]!,ids[j]!]});
  const all=[...operations,...ids.map(id=>({key:`risk_review:${id}`,stage:'risk_review' as const,assetIds:[id]}))];
  if(!profile)return all;
  if(!Number.isFinite(baseReservation)||baseReservation!<=0)throw new ProjectApiError(503,'Photo processing capacity is unavailable.');
  return all.map(op=>({...op,reservationUsd:Math.max(baseReservation!,profile.routes[op.stage].maximumCallCostUsd)}));
}
export function assertCompletePhotoPayload(profile:CompletePhotoProfile,assets:readonly PhotoSourceAsset[],operations:readonly PhotoOperation[]):void{
  for(const op of operations){
    const route=profile.routes[op.stage],sources=op.assetIds.map(id=>assets.find(a=>a.id===id)!);
    // Exact base64 expansion plus the full configured context bound and JSON framing.
    const bytes=sources.reduce((n,a)=>n+Math.ceil(a.byteSize/3)*4,0)+profile.maximumContextBytes+100_000;
    // Primary image-input documentation, reviewed 2026-10-03; do not silently
    // downsample a supplied view to make a purchased high-detail pass fit.
    const limit=route.provider==='gemini'?20_000_000:route.provider==='claude'?32_000_000:512_000_000;
    if(bytes>limit||route.provider==='claude'&&sources.some(a=>a.widthPixels>8000||a.heightPixels>8000||Math.ceil(a.byteSize/3)*4>10_000_000)
      ||route.model==='gpt-6-astra'&&sources.some(a=>a.widthPixels>65535||a.heightPixels>65535||Math.ceil(a.widthPixels/32)*Math.ceil(a.heightPixels/32)>30000))
      throw new ProjectApiError(413,'These photos exceed the reading limits at the selected detail level. Please contact support before paying.');
  }
}
