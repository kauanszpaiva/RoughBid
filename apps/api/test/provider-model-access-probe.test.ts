import test from 'node:test';
import assert from 'node:assert/strict';
import { probeProviderModelAccess } from '../../../scripts/probe-provider-model-access.mjs';

test('model access probes use only fixed authenticated GETs and never return provider bodies or credentials',async()=>{
  const secret='unit_private_secret';const requests:string[]=[];
  const result=await probeProviderModelAccess({OPENAI_API_KEY:secret,ANTHROPIC_API_KEY:secret,KIMI_API_KEY:secret,DEEPSEEK_API_KEY:secret},async(url:any,init:any)=>{
    assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.body,undefined);requests.push(url);
    if(url.includes('openai'))return Response.json({id:'gpt-6-astra',credential_echo:secret});
    if(url.includes('anthropic'))return Response.json({error:{message:secret}},{status:401});
    if(url.includes('moonshot'))return Response.json({data:[{id:'kimi-k3',credential_echo:secret}]});
    throw new Error(secret);
  });
  assert.equal(requests.length,4);assert.equal(result.providers.filter((p:any)=>p.modelAvailable).length,2);
  assert.equal(result.inferenceCalls,0);assert.equal(result.providerBalanceVerified,false);
  assert.ok(!JSON.stringify(result).includes(secret));assert.ok(result.providers.every((p:any)=>!p.inferenceVerified));
});
test('absent credentials never make a metadata request',async()=>{
  const result=await probeProviderModelAccess({},async()=>{throw new Error('unexpected network');});
  assert.ok(result.providers.every((p:any)=>p.status==='not_configured'&&p.httpStatus===null));
});
