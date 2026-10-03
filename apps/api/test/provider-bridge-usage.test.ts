import test from 'node:test';
import assert from 'node:assert/strict';
import {bridgeUsage,reviewedBridgePayload,type BridgeUsageRoute} from '../src/provider-bridge/usage.ts';
import {withUsageMeter,meterGeminiCall,meterOpenAiCompatibleCall,meterAnthropicCall,type ProviderSpendRequirement} from '../src/owner-usage/meter.ts';
const at=Date.parse('2026-10-03T12:00:00Z');
const route=(provider:string,model:string,input:number,output:number):BridgeUsageRoute=>({provider,model,maxOutputTokens:64000,
  ...(provider==='openai'?{requestPolicy:'explicit-cache-default-v1' as const}:{}),tariff:{inputUsdPerMillion:input,outputUsdPerMillion:output,
  inputTokenLimit:1048576,outputTokenLimit:64000,additionalRequestUsd:0,standardUncached:true,reasoningIncluded:true,maximumAcceptedInput:true,
  source:'https://example.invalid/synthetic-reviewed-fixture',verifiedAt:'2026-10-01T00:00:00Z',expiresAt:'2027-01-01T00:00:00Z'}});
const astra=route('openai','gpt-6-astra',20,75),opus=route('claude','claude-opus-5-5',8,20),kimi=route('kimi','kimi-k3',6,15),
  gemini=route('gemini','gemini-3.1-pro-preview',4,18),deepseek=route('deepseek','deepseek-flash',.3,1.2);
function body(r:BridgeUsageRoute):Record<string,any>{
  if(r.provider==='gemini')return{generationConfig:{maxOutputTokens:64000}};
  if(r.provider==='openai')return{model:r.model,max_output_tokens:64000,service_tier:'default',prompt_cache_options:{mode:'explicit'}};
  return{model:r.model,[r.provider==='kimi'?'max_completion_tokens':'max_tokens']:64000};
}
function cost(r:BridgeUsageRoute,usage:unknown,extra:Record<string,unknown>={},payload=body(r)){
  return bridgeUsage({model:r.model,...extra,[r.provider==='gemini'?'usageMetadata':'usage']:usage},r,payload,at);
}
test('five provider totals price real tokens conservatively; cache and reasoning are never counted twice',()=>{
  assert.deepEqual(cost(astra,{input_tokens:1000,output_tokens:200,input_tokens_details:{cached_tokens:100},output_tokens_details:{reasoning_tokens:150},total_tokens:1200}),
    {input_tokens:1000,output_tokens:200,estimated_cost_usd:.035});
  // Anthropic input_tokens excludes both cache buckets; all are billed at the reviewed maximum input rate.
  assert.deepEqual(cost(opus,{input_tokens:700,cache_read_input_tokens:100,cache_creation_input_tokens:200,
    cache_creation:{ephemeral_5m_input_tokens:50,ephemeral_1h_input_tokens:150},output_tokens:200,service_tier:'standard'}),
    {input_tokens:1000,output_tokens:200,estimated_cost_usd:.012});
  assert.deepEqual(cost(kimi,{prompt_tokens:1000,completion_tokens:200,prompt_tokens_details:{cached_tokens:100,cache_write_tokens:300},cached_tokens:100,total_tokens:1200}),
    {input_tokens:1000,output_tokens:200,estimated_cost_usd:.009});
  assert.deepEqual(cost(gemini,{promptTokenCount:1000,candidatesTokenCount:50,thoughtsTokenCount:150,cachedContentTokenCount:100}),
    {input_tokens:1000,output_tokens:200,estimated_cost_usd:.0076});
  assert.deepEqual(cost(deepseek,{prompt_tokens:1000,completion_tokens:200,prompt_cache_hit_tokens:100,prompt_cache_miss_tokens:900,
    completion_tokens_details:{reasoning_tokens:150},total_tokens:1200}),{input_tokens:1000,output_tokens:200,estimated_cost_usd:.00054});
});
test('tariff binds model, service tier, explicit cache policy, output field and absence of separately charged features',()=>{
  for(const r of [astra,opus,kimi,gemini,deepseek]){
    assert.equal(reviewedBridgePayload(r,body(r)),true);
    assert.equal(reviewedBridgePayload(r,{...body(r),tools:[{type:'web_search'}]}),false);
    assert.equal(reviewedBridgePayload(r,{...body(r),service_tier:'priority'}),false);
  }
  for(const bad of [{...body(astra),model:'another-model'},{...body(astra),max_output_tokens:64001},
    {...body(astra),service_tier:undefined},{...body(astra),prompt_cache_options:{mode:'implicit'}},
    {...body(astra),input:[{content:[{prompt_cache_breakpoint:true}]}]},{...body(astra),context_management:[{type:'compaction'}]}])assert.equal(reviewedBridgePayload(astra,bad),false);
  assert.equal(reviewedBridgePayload(kimi,{model:kimi.model,max_tokens:64000}),false);
  assert.equal(reviewedBridgePayload(kimi,{...body(kimi),prompt_cache_options:{mode:'implicit',ttl:'1h'}}),false);
  assert.equal(reviewedBridgePayload(gemini,{generationConfig:{maxOutputTokens:64000,candidateCount:2}}),false);
  assert.equal(reviewedBridgePayload(opus,{...body(opus),messages:[{content:[{cache_control:{type:'ephemeral'}}]}]}),false);
});
test('missing, malformed, conflicting, or unexpected paid telemetry retains unknown cost',()=>{
  for(const u of [{input_tokens:1000},{input_tokens:'1000',output_tokens:1},{input_tokens:1000,output_tokens:-1},
    {input_tokens:1000,output_tokens:200,total_tokens:1001},{input_tokens:1000,output_tokens:200,output_tokens_details:{reasoning_tokens:201}},
    {input_tokens:1000,output_tokens:200,output_tokens_details:null},{input_tokens:1000,output_tokens:200,output_tokens_details:100},
    {input_tokens:1000,output_tokens:200,input_tokens_details:null},{input_tokens:1000,output_tokens:200,input_tokens_details:{cached_tokens:null}},
    {input_tokens:1000,output_tokens:200,input_tokens_details:{cached_tokens:1001}},
    {input_tokens:1000,output_tokens:200,input_tokens_details:{cache_write_tokens:1}}])assert.equal(cost(astra,u).estimated_cost_usd,undefined);
  assert.equal(cost(astra,{input_tokens:1000,output_tokens:200},{service_tier:'priority'}).estimated_cost_usd,undefined);
  assert.equal(cost(astra,{input_tokens:1000,output_tokens:200},{model:'another-model'}).estimated_cost_usd,undefined);
  assert.equal(cost(kimi,{prompt_tokens:1000,completion_tokens:200,prompt_tokens_details:{cached_tokens:900,cache_write_tokens:200}}).estimated_cost_usd,undefined);
  assert.equal(cost(deepseek,{prompt_tokens:1000,completion_tokens:200,prompt_cache_hit_tokens:200,prompt_cache_miss_tokens:900}).estimated_cost_usd,undefined);
  assert.equal(cost(gemini,{promptTokenCount:1000,candidatesTokenCount:50,thoughtsTokenCount:null}).estimated_cost_usd,undefined);
  assert.equal(cost(gemini,{promptTokenCount:1000,candidatesTokenCount:null}).estimated_cost_usd,undefined);
  assert.equal(cost(gemini,{promptTokenCount:1000,candidatesTokenCount:50,totalTokenCount:1200}).estimated_cost_usd,undefined);
  assert.equal(cost(gemini,{promptTokenCount:1000,candidatesTokenCount:50,thoughtsTokenCount:150,totalTokenCount:1200}).estimated_cost_usd,.0076);
  assert.equal(cost(opus,{input_tokens:1000,output_tokens:200,cache_creation_input_tokens:2,cache_creation:{ephemeral_5m_input_tokens:1}}).estimated_cost_usd,undefined);
  assert.equal(cost({...opus,tariff:{...opus.tariff!,inputUsdPerMillion:4}},{input_tokens:1000,output_tokens:200,cache_creation_input_tokens:1}).estimated_cost_usd,undefined);
  assert.equal(cost({...kimi,tariff:{...kimi.tariff!,inputUsdPerMillion:3}},{prompt_tokens:1000,completion_tokens:200}).estimated_cost_usd,undefined);
});
test('capture is a micro-rounded estimate only, preserves cost above hold, and expires instead of silently repricing',()=>{
  assert.equal(cost(deepseek,{prompt_tokens:1,completion_tokens:1}).estimated_cost_usd,.000002);
  const exposure=cost(astra,{input_tokens:986000,output_tokens:64001});assert.equal(exposure.estimated_cost_usd,24.520075);
  assert.equal(exposure.actual_cost_usd,undefined);
  assert.equal(bridgeUsage({usage:{input_tokens:1000,output_tokens:200}},astra,body(astra),Date.parse('2027-01-01T00:00:00Z')).estimated_cost_usd,undefined);
  assert.equal(cost({...astra,tariff:undefined},{input_tokens:1000,output_tokens:200}).estimated_cost_usd,undefined);
  const flash={...route('gemini','gemini-3.8-flash',.75,3.75),tariff:undefined};
  assert.equal(cost(flash,{promptTokenCount:1000,candidatesTokenCount:200}).estimated_cost_usd,.0015);
});

test('reviewed direct adapters settle the same event exactly once; unknown callback never falls back or releases the hold',async()=>{
  for(const provider of ['gemini','claude','openai','kimi','deepseek']as const){
    for(const mode of ['known','unknown','malformed','throws']as const){
      const rows:any[]=[],rpcCalls:Array<{name:string;args:Record<string,unknown>}>=[];let emissions=0;
      const writer={from(){return{insert:async(row:any)=>{rows.push(row);return{error:null};},update:(patch:any)=>({eq:async()=>{Object.assign(rows[0],patch);return{error:null};}})};},
        async rpc(name:string,args:Record<string,unknown>){rpcCalls.push({name,args});return{data:{reserved_usd:2.5},error:null};}};
      const response={usageMetadata:{promptTokenCount:1000,candidatesTokenCount:200},usage:{prompt_tokens:1000,completion_tokens:200,inputTokens:1000,outputTokens:200}};
      const requirement:ProviderSpendRequirement={minimumReservationUsd:2.5,reviewedTelemetry:(value)=>{
        assert.equal(value,response);if(mode==='throws')throw Error('Synthetic calculator failure');
        return mode==='unknown'?null:{inputTokens:mode==='malformed'?-1:1000,outputTokens:200,estimatedCostUsd:3,providerRequestId:'synthetic-request'};}};
      const call=async()=>{emissions++;return response;};
      await withUsageMeter({writer,userId:'u',workspaceId:'w',projectId:'p',jobId:'r',billing:'paid'},()=>
        provider==='gemini'?meterGeminiCall('gemini-3.8-flash','generate',call,requirement):provider==='claude'?meterAnthropicCall(provider,'claude-opus-5-5',call,requirement):meterOpenAiCompatibleCall(provider,provider,call,requirement));
      assert.equal(emissions,1);assert.equal(rows.length,1);assert.equal(rows[0].actual_cost_usd,null);
      assert.deepEqual(rpcCalls.map(c=>c.name),['reserve_provider_spend','capture_provider_spend']);
      assert.equal(rpcCalls[0]!.args.p_required_reservation_usd,2.5);
      assert.equal(rpcCalls[1]!.args.p_event_id,rows[0].id);
      assert.equal(rpcCalls[1]!.args.p_estimated_cost_usd,mode==='known'?3:null);
      assert.equal(rows[0].operation,`rb1:r:generate:${mode==='known'?'measured':'unknown'}`);
    }
  }
});
