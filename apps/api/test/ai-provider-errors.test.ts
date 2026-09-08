import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiPlanReader } from '../src/ai-plan/gemini.ts';
import { MultiProviderPlanReader } from '../src/ai-plan/multi-provider.ts';
import { AiProviderError, classifyProviderFailure } from '../src/ai-plan/provider-errors.ts';
import { PilotPlanReader } from '../src/ai-plan/pilot-reader.ts';

const context={provider:'gemini',model:'gemini-2.5-flash',stage:'generate' as const,durationMs:245};
test('provider status and machine reasons are preserved without credential, request or response text',()=>{
  const error={status:400,message:JSON.stringify({error:{code:400,status:'INVALID_ARGUMENT',message:'SECRET_KEY_VALUE CLIENT_ADDRESS PDF_TEXT',details:[{reason:'API_KEY_INVALID',metadata:{apiKey:'SECRET_KEY_VALUE',url:'https://private.test?key=SECRET_KEY_VALUE'}}]}}),request:{pdf:'PDF_TEXT'},stack:'CLIENT_ADDRESS'};
  const result=classifyProviderFailure(error,context);
  assert.ok(result instanceof AiProviderError);assert.equal(result.status,503);
  assert.equal(result.diagnostic.code,'provider_credentials');assert.equal(result.diagnostic.reason,'API_KEY_INVALID');assert.equal(result.diagnostic.provider_status,400);
  assert.doesNotMatch(JSON.stringify(result),/SECRET_KEY_VALUE|CLIENT_ADDRESS|PDF_TEXT|private\.test/);
  assert.doesNotMatch(result.message,/SECRET_KEY_VALUE|CLIENT_ADDRESS|PDF_TEXT/);
  assert.match(result.message,/Reference:/);
  const leaked=classifyProviderFailure({status:403,message:'Your API key was reported as leaked. Please use another API key. SECRET_KEY_VALUE'},context);
  assert.equal(leaked.diagnostic.reason,'API_KEY_REPORTED_LEAKED');assert.doesNotMatch(JSON.stringify(leaked),/SECRET_KEY_VALUE/);
});
test('safe classification distinguishes permission, quota, model, timeout, network and output failures',()=>{
  for(const [raw,code,status] of [[{status:403},'provider_permissions',503],[{status:429},'provider_quota',503],[{status:404},'provider_model_unavailable',503],[{name:'TimeoutError'},'provider_timeout',504],[{status:503},'provider_unavailable',503],[{status:400},'provider_request_rejected',502]] as const){
    const result=classifyProviderFailure(raw,context);assert.equal(result.diagnostic.code,code);assert.equal(result.status,status);
  }
  const unknown=classifyProviderFailure({status:'secret',message:'SECRET_TEXT',error:{status:'SECRET_REASON'}},{...context,model:'SECRET_KEY_VALUE',provider:'SECRET_PROVIDER'});
  assert.equal(unknown.diagnostic.reason,null);assert.equal(unknown.diagnostic.provider_status,null);
  assert.equal(unknown.diagnostic.model,'configured-model');assert.equal(unknown.diagnostic.provider,'other');
});
test('Gemini error passes through multiple providers with one structured redacted log and the same reference',async()=>{
  const logs:unknown[][]=[];const original=console.error;console.error=(...args)=>{logs.push(args);};
  try{
    const gemini=new GeminiPlanReader({generateContent:async()=>{throw{status:403,message:JSON.stringify({error:{status:'PERMISSION_DENIED',message:'SECRET_PDF_SECRET_KEY'}})};}},['gemini-2.5-flash']);
    const reader=new MultiProviderPlanReader([{name:'gemini',read:input=>gemini.read(input)}]);
    await assert.rejects(reader.read({fileBytes:new Uint8Array([1]),mimeType:'application/pdf',sheetName:'PRIVATE_FILE_NAME',requestedTrades:['Framing'],scope:'PRIVATE_SCOPE'}),(error:any)=>{
      assert.equal(error.status,503);assert.equal(error.diagnostic.code,'provider_permissions');
      assert.equal(logs.length,1);assert.equal((logs[0]?.[1] as any).reference,error.diagnostic.reference);return true;
    });
    assert.equal(logs[0]?.[0],'ai_provider_failure');assert.doesNotMatch(JSON.stringify(logs),/SECRET_PDF_SECRET_KEY|PRIVATE_FILE_NAME|PRIVATE_SCOPE/);
  }finally{console.error=original;}
});
test('invalid JSON output receives a safe error and never logs response bytes',async()=>{
  const logs:unknown[][]=[];const original=console.error;console.error=(...args)=>{logs.push(args);};
  try{
    const reader=new GeminiPlanReader({generateContent:async()=>({text:'PRIVATE_PLAN_TEXT_NOT_JSON'})},['gemini-2.5-flash']);
    await assert.rejects(reader.read({fileBytes:new Uint8Array([1]),mimeType:'application/pdf',sheetName:'private',requestedTrades:[],scope:null}),(error:any)=>error.status===502&&error.diagnostic.code==='provider_invalid_output');
    assert.doesNotMatch(JSON.stringify(logs),/PRIVATE_PLAN_TEXT_NOT_JSON/);
  }finally{console.error=original;}
});

test('pilot countTokens failures are sanitized without inference or automatic retries',async()=>{
  const logs:unknown[][]=[];const original=console.error;console.error=(...args)=>{logs.push(args);};
  let counts=0;let generations=0;
  try{
    const reader=new PilotPlanReader({countTokens:async()=>{counts++;throw{status:403,message:'RAW_PROVIDER_KEY_OR_PLAN'};},generateContent:async()=>{generations++;return{text:'{}'};}});
    await assert.rejects(reader.read({fileBytes:new Uint8Array([1]),mimeType:'application/pdf',sheetName:'private',requestedTrades:[],scope:null}),(error:any)=>error.status===503&&error.diagnostic.stage==='count_tokens');
    assert.equal(counts,1);assert.equal(generations,0);assert.doesNotMatch(JSON.stringify(logs),/RAW_PROVIDER_KEY_OR_PLAN/);
  }finally{console.error=original;}
});
