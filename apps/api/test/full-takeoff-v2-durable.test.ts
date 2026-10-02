import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { handleAiPlanRequest } from '../src/ai-plan/routes.ts';
import { createPlanSetManifest } from '../src/takeoff-v2/preflight.ts';
import { DEEP_PASS_ORDER } from '../src/takeoff-v2/orchestrator.ts';
import { DurableFullTakeoffV2Processor, DurableFullTakeoffV2Service, createFullTakeoffV2Queue } from '../src/takeoff-v2/durable.ts';

function query(data: unknown, selected?: (columns: string) => void) {
  const result: any = {};
  result.select = (columns: string) => { selected?.(columns); return result; };
  for (const method of ['eq','maybeSingle']) result[method] = () => result;
  result.then = (resolve: any) => Promise.resolve({ data, error: null }).then(resolve);
  return result;
}
async function pdf() { const doc = await PDFDocument.create(); doc.addPage([100,100]); return new Uint8Array(await doc.save()); }
function db() {
  return { auth: { getUser: async () => ({data:{user:{id:'user'}},error:null}) }, from(table: string) {
    if(table==='profiles') return query({is_platform_admin:true});
    if(table==='workspace_members') return query({role:'estimator'});
    if(table==='workspaces') return query({ai_processing_consented_at:'2026-10-02'});
    if(table==='projects') return query({id:'project'});
    if(table==='project_files') return query({id:'file',storage_path:'workspace/project/file/source.pdf',processing_status:'ready',page_count:1});
    throw new Error(`Unexpected table ${table}`);
  } };
}

test('full HTTP always enqueues with 202 without constructing the provider, irrespective of legacy durable flag',async()=>{
  const bytes=await pdf(),originalFetch=globalThis.fetch,previous=process.env.TAKEOFF_V2_ENABLED,legacy=process.env.AI_PLAN_DURABLE_ENABLED;
  process.env.TAKEOFF_V2_ENABLED='true';process.env.AI_PLAN_DURABLE_ENABLED='false';
  globalThis.fetch=(async()=>new Response(bytes)) as typeof fetch;
  let calls=0,enqueued='';
  try {
    const response=await handleAiPlanRequest(new Request('https://test/api/projects/project/ai-plan-readings',{
      method:'POST',headers:{'x-workspace-id':'workspace','content-type':'application/json'},body:JSON.stringify({file_id:'file',mode:'full_v2'}),
    }),db() as never,{
      storage:{presign:async()=>({url:'https://storage.test/source.pdf'})},reader:{read:async()=>{calls++;throw new Error('No HTTP provider');}},
      fullTakeoffV2ProviderFactory:{create:()=>{calls++;throw new Error('No HTTP factory');}},paidReaderAvailable:false,
      fullTakeoffV2Queue:{isWorkerAvailable:async()=>true,add:async(id)=>{enqueued=id;}},
      findingsWriter:{from:()=>{throw new Error('RPC only');},rpc:async(fn,args)=>{
        if(fn==='full_takeoff_v2_worker_available')return{data:true,error:null};
        assert.equal(fn,'reserve_full_takeoff_v2');assert.equal((args.p_manifest as any).physicalPageCount,1);
        return{data:{run:{id:'run',status:'queued',progress:{completed:0,total:10}},reused:false},error:null};
      }},
    });
    assert.equal(response.status,202);assert.equal(enqueued,'run');assert.equal(calls,0);
    const mixed=await handleAiPlanRequest(new Request('https://test/api/projects/project/ai-plan-readings',{
      method:'POST',headers:{'x-workspace-id':'workspace','content-type':'application/json'},body:JSON.stringify({file_id:'file',mode:'full_v2',page_number:1}),
    }),db() as never,{storage:{presign:async()=>({url:'https://test'})},reader:{read:async()=>{calls++;throw new Error('No HTTP provider');}},findingsWriter:{from:()=>{}},paidReaderAvailable:true});
    assert.equal(mixed.status,400);assert.equal(calls,0);
  }finally {globalThis.fetch=originalFetch;if(previous===undefined)delete process.env.TAKEOFF_V2_ENABLED;else process.env.TAKEOFF_V2_ENABLED=previous;if(legacy===undefined)delete process.env.AI_PLAN_DURABLE_ENABLED;else process.env.AI_PLAN_DURABLE_ENABLED=legacy;}
});

test('missing durable schema/worker closes Full before downloading or creating a run',async()=>{
  let downloads=0,reservations=0;
  const service=new DurableFullTakeoffV2Service(db() as never,{from:()=>{throw new Error('unused');},rpc:async(fn)=>{
    if(fn==='reserve_full_takeoff_v2')reservations++;return{data:false,error:null};
  }},{presign:async()=>{downloads++;return{url:'https://test'};}},{isWorkerAvailable:async()=>true,add:async()=>{}},'user','workspace');
  await assert.rejects(service.reserve('project',{mode:'full_v2',file_id:'file'}),(e:any)=>e.status===503);
  assert.equal(downloads,0);assert.equal(reservations,0);
});

test('founder Full availability needs only authorized project and live Full heartbeat, independent of legacy reader or checkout',async()=>{
  const previous=process.env.TAKEOFF_V2_ENABLED,redis=process.env.REDIS_URL;
  process.env.TAKEOFF_V2_ENABLED='true';process.env.REDIS_URL='redis://localhost';
  try {
    const response=await handleAiPlanRequest(new Request('https://test/api/projects/project/ai-plan-entitlement',{headers:{'x-workspace-id':'workspace'}}),db() as never,{
      storage:{presign:async()=>({url:'https://test'})},reader:{read:async()=>{throw new Error('No reader required');}},paidReaderAvailable:false,
      findingsWriter:{from:()=>{},rpc:async(fn)=>{assert.equal(fn,'full_takeoff_v2_worker_available');return{data:true,error:null};}},
    });
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{freeReadingAvailable:false,fullTakeoffV2Available:true});
  }finally {if(previous===undefined)delete process.env.TAKEOFF_V2_ENABLED;else process.env.TAKEOFF_V2_ENABLED=previous;if(redis===undefined)delete process.env.REDIS_URL;else process.env.REDIS_URL=redis;}
});

test('queue retries are durable identity retries and never add a second provider attempt id',async()=>{
  let added:any;
  class Queue {async getWorkers(){return[{}];}async add(name:string,data:any,options:any){added={name,data,options};}async close(){}}
  const queue=await createFullTakeoffV2Queue('redis://localhost',async()=>({Queue}) as never);
  await queue.add('run');assert.equal(added.options.jobId,'run');assert.equal(added.options.attempts,3);
  assert.deepEqual(added.data,{runId:'run'});assert.equal(await queue.isWorkerAvailable(),true);
});

async function workerFixture(options:{cancelAfterCall?:boolean;uncertain?:boolean;reuse?:boolean}={}) {
  const bytes=await pdf(),manifest=await createPlanSetManifest(bytes),saved=new Map<string,any>(),rpcNames:string[]=[];
  let providerCalls=0,canceled=false,finalized=false,now=0;
  const writer={from:()=>{throw new Error('mock factory does not meter external requests');},rpc:async(fn:string,args:any)=>{
    rpcNames.push(fn);
    if(fn==='claim_full_takeoff_v2')return{data:{lease_id:'lease',manifest,workspace_id:'workspace',project_id:'project',file_id:'file',storage_path:'workspace/project/file/source.pdf',requested_by:'user'},error:null};
    if(fn==='heartbeat_full_takeoff_v2')return{data:!canceled,error:null};
    if(fn==='begin_full_takeoff_v2_pass'){
      if(options.uncertain)return{data:null,error:{message:'provider details should not appear'}};
      return{data:options.reuse||saved.has(args.p_pass_type)?'already_succeeded':'run',error:null};
    }
    if(fn==='checkpoint_full_takeoff_v2_pass'){saved.set(args.p_pass_type,args.p_result);return{data:true,error:null};}
    if(fn==='finish_full_takeoff_v2'){finalized=true;return{data:{status:'needs_review'},error:null};}
    if(fn==='release_full_takeoff_v2')return{data:true,error:null};
    throw new Error(`Unexpected RPC ${fn}`);
  }};
  const processor=new DurableFullTakeoffV2Processor(writer,{presign:async()=>({url:'https://storage.test/plan.pdf'})},
    {create:()=>({runPass:async()=>{providerCalls++;now+=60*60_000;if(options.cancelAfterCall)canceled=true;return{status:'succeeded',checkpoint:{evidence:'mock'}};}})},
    'worker',(async()=>new Response(bytes)) as typeof fetch,{heartbeatMs:5});
  return {processor,saved,rpcNames,get providerCalls(){return providerCalls;},get finalized(){return finalized;},get virtualElapsed(){return now;}};
}

test('worker continues beyond fifty/ninety minutes until all passes checkpoint; no total runtime deadline',async(t)=>{
  const fixture=await workerFixture(),realNow=Date.now;
  t.mock.method(Date,'now',()=>realNow()+fixture.virtualElapsed);
  const result=await fixture.processor.process({data:{runId:'run'},attemptsMade:0,opts:{attempts:3}});
  assert.equal(result.status,'needs_review');assert.equal(fixture.providerCalls,DEEP_PASS_ORDER.length);
  assert.ok(fixture.virtualElapsed>90*60_000);assert.equal(fixture.saved.size,10);assert.equal(fixture.finalized,true);
});

test('worker reuse skips completed calls; uncertain claims and cancellation never dispatch a following stage',async()=>{
  const reused=await workerFixture({reuse:true});await reused.processor.process({data:{runId:'run'},attemptsMade:0,opts:{attempts:3}});assert.equal(reused.providerCalls,0);
  const uncertain=await workerFixture({uncertain:true});await assert.rejects(uncertain.processor.process({data:{runId:'run'},attemptsMade:0,opts:{attempts:3}}),/uncertain provider passes/);assert.equal(uncertain.providerCalls,0);
  const canceled=await workerFixture({cancelAfterCall:true});await assert.rejects(canceled.processor.process({data:{runId:'run'},attemptsMade:0,opts:{attempts:3}}),/uncertain provider passes/);
  assert.equal(canceled.providerCalls,1);assert.equal(canceled.saved.size,0);assert.equal(canceled.finalized,false);
});

test('progress summary excludes source checkpoints; selected detail is limited to one pass',async()=>{
  const selected:string[]=[];
  const readDb={from:(table:string)=>query(table==='takeoff_runs'?{id:'run',project_id:'project'}:table==='plan_sheets'?[{id:'sheet',physical_page_number:1}]:[{plan_sheet_id:'sheet',pass_type:'geometry',status:'blocked'}],columns=>selected.push(columns))};
  const service=new DurableFullTakeoffV2Service(readDb as never,{from:()=>{}},{presign:async()=>({url:'https://test'})},undefined,'user','workspace');
  const result=await service.get('run');assert.equal(result.sheets[0].passes[0].status,'blocked');assert.ok(selected.every(columns=>!columns.split(',').includes('checkpoint')));
  await assert.rejects(service.checkpoint('run',201,'geometry'),(e:any)=>e.status===400);
});
