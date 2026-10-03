import type { FullRouteTariff } from '../billing/full-takeoff-pricing.ts';
import { measureGeminiUsage } from '../../../../packages/domain/src/api-usage.ts';

export interface BridgeUsageRoute {
  provider:string;model:string;maxOutputTokens:number;tariff?:FullRouteTariff;
  requestPolicy?:'explicit-cache-default-v1'|{serviceTier:'default';promptCacheMode:'explicit'};
}
type Json=Record<string,any>;
const object=(v:unknown):v is Json=>!!v&&typeof v==='object'&&!Array.isArray(v);
const count=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const zero=(v:unknown)=>v===undefined?0:count(v)?v:NaN;
function containsKey(value:unknown,keys:readonly string[]):boolean {
  if(Array.isArray(value))return value.some(v=>containsKey(v,keys));
  return object(value)&&Object.entries(value).some(([key,v])=>keys.includes(key)||containsKey(v,keys));
}
/** The actual adapter payload must satisfy the frozen pricing conditions before CAS. */
export function reviewedBridgePayload(route:BridgeUsageRoute,payload:unknown):boolean {
  if(!object(payload)||containsKey(payload,['tools','tool_choice','cachedContent','cache_control','prompt_cache_breakpoint','context_management','compaction','prewarm']))return false;
  if(route.provider!=='gemini'&&payload.model!==route.model)return false;
  if(payload.n!==undefined&&payload.n!==1||payload.stream===true||payload.truncation!==undefined&&payload.truncation!=='disabled')return false;
  if(route.provider==='openai')return (route.requestPolicy==='explicit-cache-default-v1'||object(route.requestPolicy)&&route.requestPolicy.serviceTier==='default'&&route.requestPolicy.promptCacheMode==='explicit')
    &&payload.max_output_tokens===route.maxOutputTokens&&payload.service_tier==='default'
    &&object(payload.prompt_cache_options)&&Object.keys(payload.prompt_cache_options).length===1&&payload.prompt_cache_options.mode==='explicit';
  if(payload.service_tier!==undefined&&payload.service_tier!=='standard')return false;
  if(route.provider==='claude')return payload.max_tokens===route.maxOutputTokens&&payload.speed===undefined&&payload.inference_geo===undefined;
  if(route.provider==='gemini')return payload.generationConfig?.maxOutputTokens===route.maxOutputTokens
    &&(payload.generationConfig.candidateCount===undefined||payload.generationConfig.candidateCount===1)
    &&(payload.serviceTier===undefined||payload.serviceTier==='standard');
  if(route.provider==='kimi')return payload.max_completion_tokens===route.maxOutputTokens&&payload.max_tokens===undefined
    &&(payload.prompt_cache_options===undefined||payload.prompt_cache_options.mode==='implicit'&&payload.prompt_cache_options.ttl==='5m');
  return route.provider==='deepseek'&&payload.max_tokens===route.maxOutputTokens&&payload.prompt_cache_options===undefined;
}

function measuredTokens(raw:Json,provider:string):{input:number;output:number;cached:number;written:number}|null {
  const u=provider==='gemini'?raw.usageMetadata:raw.usage;
  if(!object(u))return null;
  let input:number,output:number,cached=0,written=0;
  if(provider==='gemini'){
    if(!count(u.promptTokenCount)||!count(u.candidatesTokenCount))return null;
    input=u.promptTokenCount;output=u.candidatesTokenCount+zero(u.thoughtsTokenCount);cached=zero(u.cachedContentTokenCount);
    if(zero(u.toolUsePromptTokenCount)!==0||u.totalTokenCount!==undefined&&(!count(u.totalTokenCount)||u.totalTokenCount!==input+output))return null;
  }else if(provider==='claude'){
    cached=zero(u.cache_read_input_tokens);written=zero(u.cache_creation_input_tokens);
    input=u.input_tokens+cached+written;output=u.output_tokens;
    if(!count(u.input_tokens)||u.service_tier!==undefined&&u.service_tier!=='standard')return null;
    if(u.cache_creation!==undefined){
      if(!object(u.cache_creation)||zero(u.cache_creation.ephemeral_5m_input_tokens)+zero(u.cache_creation.ephemeral_1h_input_tokens)!==written)return null;
    }
    if(u.server_tool_use!==undefined&&(!object(u.server_tool_use)||Object.values(u.server_tool_use).some(v=>v!==0)))return null;
  }else{
    input=provider==='openai'?u.input_tokens:u.prompt_tokens;output=provider==='openai'?u.output_tokens:u.completion_tokens;
    const details=provider==='openai'?u.input_tokens_details:u.prompt_tokens_details;
    if(details!==undefined&&!object(details))return null;
    cached=zero(details?.cached_tokens!==undefined?details.cached_tokens:u.cached_tokens);written=zero(details?.cache_write_tokens);
    const outputDetails=provider==='openai'?u.output_tokens_details:u.completion_tokens_details;
    if(outputDetails!==undefined&&!object(outputDetails))return null;
    const reasoning=outputDetails?.reasoning_tokens;
    if(reasoning!==undefined&&(!count(reasoning)||reasoning>output))return null; // Already included in output; never add it twice.
    if(u.cached_tokens!==undefined&&(!count(u.cached_tokens)||u.cached_tokens!==cached))return null;
    if(provider==='deepseek'&&(u.prompt_cache_hit_tokens!==undefined||u.prompt_cache_miss_tokens!==undefined)){
      if(!count(u.prompt_cache_hit_tokens)||!count(u.prompt_cache_miss_tokens)||u.prompt_cache_hit_tokens+u.prompt_cache_miss_tokens!==input
        ||details?.cached_tokens!==undefined&&details.cached_tokens!==u.prompt_cache_hit_tokens)return null;
      cached=u.prompt_cache_hit_tokens;
    }
    if(u.total_tokens!==undefined&&(!count(u.total_tokens)||u.total_tokens!==input+output))return null;
  }
  return count(input)&&count(output)&&count(cached)&&count(written)&&cached+written<=input?{input,output,cached,written}:null;
}

/**
 * Conservative estimate from real provider token totals, never an invoice cost.
 * Rates are the immutable reviewed worst applicable tier; no cache discount is assumed.
 * Claude input excludes cache buckets; OpenAI/Kimi/DeepSeek totals already include them.
 * Sources: platform.claude.com/docs/en/build-with-claude/prompt-caching,
 * platform.kimi.ai/docs/api/chat, api-docs.deepseek.com/api/create-chat-completion/,
 * developers.openai.com/api/reference/cli/resources/responses/methods/create,
 * ai.google.dev/api/generate-content#UsageMetadata.
 */
export function bridgeUsage(value:unknown,route:BridgeUsageRoute,payload:unknown,dispatchedAt=Date.now()):Record<string,unknown> {
  const raw=object(value)&&object(value.raw)?value.raw:object(value)?value:{},measured=measuredTokens(raw,route.provider);
  const id=raw.responseId??raw.id;
  const result:Record<string,unknown>={...(measured?{input_tokens:measured.input,output_tokens:measured.output}:{}),
    ...(typeof id==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test(id)?{provider_request_id:id}:{})};
  if(!measured)return result;
  const reportedModel=raw.model??raw.modelVersion;
  if(reportedModel!==undefined&&reportedModel!==route.model)return result;
  if(raw.service_tier!==undefined&&!['default','standard'].includes(raw.service_tier)||raw.serviceTier!==undefined&&raw.serviceTier!=='standard')return result;
  const t=route.tariff;
  if(!t){ // Existing Gemini v1 tariff only. Other legacy profiles remain explicitly unknown.
    const cost=route.provider==='gemini'&&!containsKey(payload,['tools','cachedContent'])?measureGeminiUsage(raw.usageMetadata,route.model,new Date(dispatchedAt))?.estimatedCostUsd:null;
    if(typeof cost==='number'&&Number.isFinite(cost)&&cost>=0)result.estimated_cost_usd=cost;
    return result;
  }
  if(!reviewedBridgePayload(route,payload)||t.standardUncached!==true||t.reasoningIncluded!==true||t.maximumAcceptedInput!==true
    ||!Number.isFinite(dispatchedAt)||!(Date.parse(t.verifiedAt)<=dispatchedAt&&dispatchedAt<Date.parse(t.expiresAt))
    ||![t.inputUsdPerMillion,t.outputUsdPerMillion,t.additionalRequestUsd].every(v=>Number.isFinite(v)&&v>=0))return result;
  // Astra explicit-without-breakpoints prohibits writes. Unexpected writes invalidate that tariff proof.
  if(route.provider==='openai'&&measured.written>0)return result;
  // Claude 1h writes can cost twice normal input; the conservative reviewed 8/M covers every bucket.
  if(route.provider==='claude'&&measured.written>0&&(route.model!=='claude-opus-5-5'||t.inputUsdPerMillion<8))return result;
  // K3 automatically writes by default. The reviewed 6/M envelope includes miss+5m write conservatively.
  if(route.provider==='kimi'&&(route.model!=='kimi-k3'||t.inputUsdPerMillion<6))return result;
  const micros=Math.ceil(measured.input*t.inputUsdPerMillion+measured.output*t.outputUsdPerMillion+t.additionalRequestUsd*1e6);
  // Never clamp observed token-based exposure to a hold or claimed token maximum.
  if(Number.isSafeInteger(micros)&&micros>=0)result.estimated_cost_usd=micros/1e6;
  return result;
}
