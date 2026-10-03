import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { AI_EVIDENCE_PASSES } from '../src/takeoff-v2/stage-config.ts';
import { buildPaidFullContract, hashPaidFullContract } from '../src/billing/full-takeoff-pricing.ts';
import { ensurePaidFullRun, DurableFullTakeoffV2Processor, requeueDueFullTakeoffBudgetRuns } from '../src/takeoff-v2/durable.ts';
import { FullTakeoffBudgetWait } from '../src/takeoff-v2/budget-wait.ts';
import { assertFullTakeoffRunAccess, paidFullRunLimits } from '../src/takeoff-v2/paid-access.ts';
import { createPlanSetManifest } from '../src/takeoff-v2/preflight.ts';
import { handleAiPlanRequest } from '../src/ai-plan/routes.ts';

const env: Record<string,string> = { PAID_FULL_ENABLED:'true',STRIPE_MODE:'live',PAID_FULL_PRICING_VERSION:'unit-reviewed-v1',
  PAID_FULL_OVERHEAD_BASE_CENTS:'0',PAID_FULL_OVERHEAD_PAGE_CENTS:'0',PROJECT_PAYMENT_FIXED_CENTS:'0',PROJECT_PAYMENT_FEE_BPS:'0',
  PAID_FULL_MAXIMUM_RESERVE_USD:'8000',PAID_FULL_MAXIMUM_CALLS:'3200',TAKEOFF_V2_CALL_RESERVATION_USD:'2.5',
  TAKEOFF_V2_ENABLED:'true',TAKEOFF_V2_WORKER_ENABLED:'true',TAKEOFF_V2_STAGE_PROVIDER_ENABLED:'true',
  TAKEOFF_V2_SCHEMA_VERSION:'takeoff-v2-foundation-v1',TAKEOFF_V2_REGIONAL_REVIEW_ENABLED:'true',TAKEOFF_V2_REGION_GRID:'2',
  GEMINI_API_KEY:'unit-not-a-real-key',GEMINI_MODEL:'gemini-3.8-flash',
  TAKEOFF_V2_MODEL_ATTESTATIONS_JSON:JSON.stringify({'gemini-3.8-flash':{accountVerified:true,compatibilityVerified:true,priceVersion:'unit',maximumCallCostUsd:2.5}}),
  ...Object.fromEntries(AI_EVIDENCE_PASSES.flatMap(pass=>[[`TAKEOFF_V2_STAGE_${pass.toUpperCase()}_ENABLED`,'true'],[`TAKEOFF_V2_STAGE_${pass.toUpperCase()}_PROVIDER`,'gemini']])) };
const old=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
after(()=>{for(const[key,value]of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
function query(data:any,filters?:any[]){const q:any={select:()=>q,maybeSingle:()=>q,eq:(...args:any[])=>{filters?.push(args);return q;},then:(resolve:any)=>Promise.resolve({data,error:null}).then(resolve)};return q;}
async function input(){const pdf=await PDFDocument.create({updateMetadata:false});pdf.addPage([612,792]);const bytes=await pdf.save(),manifest=await createPlanSetManifest(bytes);
  const contract=buildPaidFullContract({manifest,membership:'standard',env});
  const quote={id:'quote',user_id:'user',workspace_id:'workspace',project_id:'project',file_id:'file',mode:'full_v2',livemode:true,status:'paid',paid_at:'2026-10-03',full_contract:contract,full_contract_hash:hashPaidFullContract(contract)};
  return{bytes,manifest,quote,authorization:{quoteId:'quote',paymentRevision:1,contractHash:quote.full_contract_hash,approvedBy:'user',contract}};
}

test('paid HTTP reserves the signed-paid contract and enqueues one identity without downloading or constructing an AI provider',async()=>{
  const f=await input();const calls:any[]=[],filters:any[]=[],enqueued:string[]=[];
  const writer={from:()=>query(f.quote,filters),rpc:async(name:string,args:any)=>{calls.push({name,args});return {data:name==='full_takeoff_v2_worker_available'?true:{run:{id:'run',status:'queued'},reused:true},error:null};}};
  const db={auth:{getUser:async()=>({data:{user:{id:'user'}},error:null})},from:()=>{throw new Error('Paid quote identity must come from the scoped server query');}};
  const response=await handleAiPlanRequest(new Request('https://test/api/projects/project/ai-plan-readings',{method:'POST',headers:{'x-workspace-id':'workspace','content-type':'application/json'},
    body:JSON.stringify({file_id:'file',mode:'full_v2',quote_id:'quote',spend_approval:{budgetsUsd:{gemini:99999}},manifest:{fileSha256:'forged'}})}),db as never,
    {storage:{presign:async()=>{throw new Error('No download during paid enqueue');}},reader:{read:async()=>{throw new Error('No provider');}},
      findingsWriter:writer,fullTakeoffV2ProviderFactory:{create:()=>{throw new Error('No factory');}},fullTakeoffV2Queue:{isWorkerAvailable:async()=>true,add:async id=>{enqueued.push(id);}}});
  assert.equal(response.status,202);assert.deepEqual(enqueued,['run']);assert.equal((await response.json()).resumed,true);
  const reserved=calls.find(call=>call.name==='reserve_paid_full_takeoff_v2');assert.equal(reserved.args.p_contract_hash,f.quote.full_contract_hash);
  assert.deepEqual(filters.filter(item=>['user_id','workspace_id','project_id','file_id'].includes(item[0])),[['user_id','user'],['workspace_id','workspace'],['project_id','project'],['file_id','file']]);
});

test('unpaid, test-mode, revoked, changed-contract and offline-worker cases do not reserve or enqueue',async()=>{
  const f=await input();
  for(const patch of [{status:'quoted',paid_at:null},{livemode:false},{status:'revoked'},{full_contract_hash:'a'.repeat(64)}]){
    let reserved=0;const writer={from:()=>query({...f.quote,...patch}),rpc:async()=>{reserved++;return{data:true,error:null};}};
    await assert.rejects(ensurePaidFullRun(writer,{isWorkerAvailable:async()=>true,add:async()=>{throw new Error('No enqueue');}},'quote'));assert.equal(reserved,0);
  }
  let reserves=0;const writer={from:()=>query(f.quote),rpc:async(name:string)=>{if(name==='reserve_paid_full_takeoff_v2')reserves++;return{data:true,error:null};}};
  await assert.rejects(ensurePaidFullRun(writer,{isWorkerAvailable:async()=>false,add:async()=>{}},'quote'),/awaits an available/);assert.equal(reserves,0);
});

test('lost enqueue acknowledgement is recoverable with the same paid run and no browser payment authority',async()=>{
  const f=await input();const ids:string[]=[];let failed=true;
  const writer={from:()=>query(f.quote),rpc:async(name:string)=>({data:name==='full_takeoff_v2_worker_available'?true:{run:{id:'saved-run',status:'queued'},reused:true},error:null})};
  const queue={isWorkerAvailable:async()=>true,add:async(id:string)=>{ids.push(id);if(failed){failed=false;throw new Error('lost ack');}}};
  await assert.rejects(ensurePaidFullRun(writer,queue,'quote'),/saved/);assert.equal((await ensurePaidFullRun(writer,queue,'quote')).id,'saved-run');assert.deepEqual(ids,['saved-run','saved-run']);
});

test('a revoked paid run never inherits platform admin privilege, and paid budget is tied to exact plan/profile',async()=>{
  const db={from:(table:string)=>{assert.equal(table,'takeoff_runs');return query({id:'run',payment_kind:'paid'});}};
  await assert.rejects(assertFullTakeoffRunAccess(db as never,{from:()=>{},rpc:async()=>({data:false,error:null})},'run','admin','workspace'),/revoked/);
  const f=await input();const manifest={...f.manifest,paidAuthorization:f.authorization};
  const limits=paidFullRunLimits(manifest,{...env,TAKEOFF_V2_RUN_SPEND_LIMITS_JSON:'{"gemini":{"approvedUsd":5}}'});
  assert.equal(limits[0]!.approvedUsd,40);assert.equal(limits[0]!.maximumCalls,16);assert.equal(limits[0]!.approvalRef,'paid-full-v1:quote:1');
  assert.throws(()=>paidFullRunLimits({...manifest,fileSha256:'f'.repeat(64)},env),/revision/);
  assert.throws(()=>paidFullRunLimits(manifest,{...env,TAKEOFF_V2_REGION_GRID:'3'}));
});

test('worker rejects paid approval belonging to another actor before any provider factory call',async()=>{
  const f=await input();let calls=0;
  const writer={from:()=>{},rpc:async(name:string)=>({data:name==='claim_full_takeoff_v2'?{lease_id:'lease',manifest:{...f.manifest,paidAuthorization:{...f.authorization,approvedBy:'other'}},
    requested_by:'user',workspace_id:'workspace',project_id:'project',file_id:'file',storage_path:'workspace/project/file/source.pdf'}:true,error:null})};
  const processor=new DurableFullTakeoffV2Processor(writer,{presign:async()=>({url:'https://storage.test/fixture.pdf'})},{create:()=>{calls++;throw new Error('No provider');}},'worker',
    (async()=>new Response(f.bytes)) as typeof fetch);
  await assert.rejects(processor.process({data:{runId:'run'},attemptsMade:0,opts:{attempts:3}}));assert.equal(calls,0);
});

test('physical page hashes remain stable across wall-clock time for a paid revision',async()=>{
  const f=await input();await new Promise(resolve=>setTimeout(resolve,1100));
  const again=await createPlanSetManifest(f.bytes);assert.deepEqual(again.sheets.map(sheet=>sheet.pageSha256),f.manifest.sheets.map(sheet=>sheet.pageSha256));
});

test('company waiting is a successful queue suspension without finish, failure or retry consumption',async()=>{
  const f=await input(),calls:string[]=[];let claims=0;
  const writer={from:()=>{},rpc:async(name:string)=>{calls.push(name);
    if(name==='claim_full_takeoff_v2')return{data:{lease_id:'lease',manifest:{...f.manifest,paidAuthorization:f.authorization},requested_by:'user',workspace_id:'workspace',project_id:'project',file_id:'file',storage_path:'workspace/project/file/source.pdf'},error:null};
    if(name==='inspect_full_takeoff_v2_pass')return{data:'run',error:null};
    if(name==='wait_full_takeoff_budget')return{data:{status:'waiting_budget',not_before:'2026-10-05T00:00:00Z'},error:null};
    if(name.includes('begin_'))claims++;
    return{data:true,error:null};}};
  const processor=new DurableFullTakeoffV2Processor(writer,{presign:async()=>({url:'https://storage.test/fixture.pdf'})},
    {create:()=>({defersCheckpointClaim:true,runPass:async request=>{throw new FullTakeoffBudgetWait(request,'event');}})},'worker',(async()=>new Response(f.bytes)) as typeof fetch);
  const result=await processor.process({data:{runId:'run'},attemptsMade:2,opts:{attempts:3}});
  assert.equal(result.status,'waiting_budget');assert.equal(claims,0);
  assert.equal(calls.includes('finish_full_takeoff_v2'),false);assert.equal(calls.includes('fail_full_takeoff_boundary'),false);assert.equal(calls.includes('release_full_takeoff_v2'),false);
});

test('restart recovery repeats the same waiting identity after lost enqueue acknowledgement',async()=>{
  const id='00000000-0000-4000-8000-000000000001',added:string[]=[];let fail=true;
  const writer={from:()=>{},rpc:async()=>({data:[{run_id:id}],error:null})};
  const queue={add:async(id:string)=>{added.push(id);if(fail){fail=false;throw new Error('offline lost ack');}}};
  await assert.rejects(requeueDueFullTakeoffBudgetRuns(writer,queue));
  assert.equal(await requeueDueFullTakeoffBudgetRuns(writer,queue),1);assert.deepEqual(added,[id,id]);
});

test('same source bytes preserve legacy saved page identity on reload without rewriting existing evidence',async()=>{
  const f=await input();const saved={...f.manifest,sheets:f.manifest.sheets.map(sheet=>({...sheet,pageSha256:'a'.repeat(64)})),spendApproval:{approvedBy:'user'}};let observed='';
  const writer={from:()=>{},rpc:async(name:string)=>({data:name==='claim_full_takeoff_v2'?{lease_id:'lease',manifest:saved,requested_by:'user',workspace_id:'workspace',project_id:'project',file_id:'file',storage_path:'workspace/project/file/source.pdf'}:name==='begin_full_takeoff_v2_pass'?'already_succeeded':true,error:null})};
  const processor=new DurableFullTakeoffV2Processor(writer,{presign:async()=>({url:'https://storage.test/fixture.pdf'})},
    {create:input=>{observed=input.manifest.sheets[0]!.pageSha256;return{runPass:async()=>{throw new Error('Already saved must not dispatch');}};}},'worker',(async()=>new Response(f.bytes)) as typeof fetch);
  await processor.process({data:{runId:'run'},attemptsMade:0,opts:{attempts:3}});assert.equal(observed,'a'.repeat(64));
});
