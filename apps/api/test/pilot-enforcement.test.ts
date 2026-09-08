import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { AiPlanReadingService } from '../src/ai-plan/service.ts';
import { handleAiPlanRequest } from '../src/ai-plan/routes.ts';

function query(data: unknown) {
  const q: any = {};
  for (const m of ['select','eq','gte','maybeSingle','single','order']) q[m] = () => q;
  q.then = (resolve: any, reject: any) => Promise.resolve({ data, error: null }).then(resolve, reject);
  return q;
}
const db: any = { auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) }, from(table: string) {
  if (table === 'profiles') return query({ is_platform_admin: false });
  if (table === 'workspaces') return query({ ai_processing_consented_at: '2026-09-08' });
  if (table === 'projects') return query({ id: 'project-1' });
  if (table === 'project_files') return query({ id:'file-1', storage_path:'workspace-1/project-1/file-1/source.pdf', original_name:'plan.pdf', processing_status:'ready' });
  if (table === 'plan_reading_jobs') return query(Array.from({length:30}, (_,i) => ({id:String(i)})));
  throw new Error(table);
} };
const storage = { presign: async () => ({ url: 'https://storage.example/plan.pdf' }) };
const forbiddenReader = { read: async () => { throw new Error('Unrestricted provider invoked'); } };
const finding = { page_number:1, finding_type:'question' as const, label:'Verify in field', quantity:null, unit:null, confidence:0.8, geometry:{}, source_excerpt:'VERIFY IN FIELD', value_text:null };
const result = { summary: { sheet_count:1, detected_trade_scope:[], scale_status:'missing' as const, human_review_required:true as const, limitations:[] }, findings:[finding] };

async function pdf(pages = 1) { const d = await PDFDocument.create(); for(let i=0;i<pages;i++)d.addPage(); return new Uint8Array(await d.save()); }

test('pilot budget reserves before provider; failed invocation stays counted and never uses paid fallback', async () => {
  const calls: string[] = [];
  const writer = { from: () => ({}), rpc: async (name: string, args: any) => {
    calls.push(name);
    if(name==='reserve_pilot_reading') { assert.equal(args.p_page_count,1); return {data:{job:{id:'job-1'},reused:false},error:null}; }
    assert.equal(name,'finish_pilot_reading'); assert.match(args.p_error,/Provider failed/);
    return {data:{status:'failed'},error:null};
  } };
  const bytes=await pdf();
  const service = new AiPlanReadingService(db, writer, storage, forbiddenReader, 'user-1','workspace-1',async()=>new Response(bytes),undefined,false,
    {read:async()=>{calls.push('provider'); throw new Error('Provider failed');}});
  await assert.rejects(service.create('project-1',{file_id:'file-1',quote_id:'malicious-quote'}),/Provider failed/);
  assert.deepEqual(calls,['reserve_pilot_reading','provider','finish_pilot_reading']);
});

test('actual PDF page limit stops reservation and provider before metadata can understate size', async () => {
  const bytes=await pdf(11);
  const writer={from:()=>({}),rpc:async()=>{throw new Error('must not reserve');}};
  const service = new AiPlanReadingService(db,writer,storage,forbiddenReader,'user-1','workspace-1',async()=>new Response(bytes),undefined,false,forbiddenReader);
  await assert.rejects(service.create('project-1',{file_id:'file-1',page_count:1}),/at most 10 MB and 10 pages/);
});

test('budget rejection never invokes any provider', async () => {
  const bytes=await pdf();
  const writer={from:()=>({}),rpc:async()=>({data:null,error:{message:'Cohort budget exhausted'}})};
  const service = new AiPlanReadingService(db,writer,storage,forbiddenReader,'user-1','workspace-1',async()=>new Response(bytes),undefined,false,forbiddenReader);
  await assert.rejects(service.create('project-1',{file_id:'file-1'}),/Cohort budget exhausted/);
});

test('verified owner remains unlimited after 30 prior jobs', async () => {
  const bytes=await pdf();
  const writer={from:()=>({}),rpc:async(name:string)=>({error:null,data:name==='reserve_platform_admin_reading'?{job:{id:'job-1'},reused:false}:{status:'needs_review'}})};
  const service = new AiPlanReadingService(db,writer,storage,{read:async()=>result},'user-1','workspace-1',async()=>new Response(bytes),undefined,true);
  assert.equal((await service.create('project-1',{file_id:'file-1'})).status,'needs_review');
});

test('active pilot cannot fall into paid/durable/free-owner flow when pilot reader unavailable', async () => {
  const previous = process.env.AI_PLAN_DURABLE_ENABLED; process.env.AI_PLAN_DURABLE_ENABLED='true';
  try {
    const response = await handleAiPlanRequest(new Request('https://roughbid.test/api/projects/project-1/ai-plan-readings',{method:'POST',headers:{'x-workspace-id':'workspace-1','content-type':'application/json'},body:JSON.stringify({file_id:'file-1',quote_id:'paid'})}),db,{
      storage,reader:forbiddenReader,paidReaderAvailable:true,pilotEnforcement:true,
      findingsWriter:{from:()=>({}),rpc:async()=>({data:{active:true},error:null})},
    });
    assert.equal(response.status,503); assert.match(await response.text(),/Pilot AI is not configured/);
  } finally { if(previous===undefined)delete process.env.AI_PLAN_DURABLE_ENABLED;else process.env.AI_PLAN_DURABLE_ENABLED=previous; }
});
