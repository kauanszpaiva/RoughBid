import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { AiPlanReadingService } from '../src/ai-plan/service.ts';
import { PDF_DIGEST } from '../src/billing/project-preflight.ts';

async function harness(options: { owner?: boolean; fail?: boolean; sourcePage?: number; consent?: boolean } = {}) {
  const doc = await PDFDocument.create();
  for (let i=1;i<=3;i++) doc.addPage([200+i*10,400]);
  const bytes = await doc.save();
  const jobs: any[] = []; const reads: any[]=[]; const calls: string[]=[];
  let next=0; let pricing: any=null;
  function query(table:string, payload?:any) {
    const filters: any[]=[]; let update:any; const q:any={};
    for(const method of ['select','order','limit']) q[method]=()=>q;
    q.eq=(k:string,v:any)=>{filters.push([k,v]);return q;};
    q.update=(v:any)=>{update=v;return q;};
    q.upsert=async(v:any)=>{pricing=v; return {data:v,error:null};};
    const run=()=>{
      if(table==='plan_reading_jobs') {
        const match=jobs.filter(j=>filters.every(([k,v])=>j[k]===v));
        if(update) for(const j of match)Object.assign(j,update);
        return {data: match.length===1?match[0]:null,error:null};
      }
      return {data: table==='project_pricing_contexts'?pricing:payload,error:null};
    };
    q.maybeSingle=async()=>run(); q.single=async()=>run(); q.then=(a:any,b:any)=>Promise.resolve(run()).then(a,b);
    return q;
  }
  const db:any={from:(table:string)=>query(table, table==='workspaces'?{ai_processing_consented_at:options.consent===false?null:'2026-09-01'}:table==='projects'?{id:'p'}:table==='project_files'?{id:'f',original_name:'test.pdf',storage_path:'w/p/f/source.pdf',processing_status:'ready',page_count:3}:null)};
  const writer:any={from:(table:string)=>query(table),rpc:async(fn:string,args:any)=>{
    calls.push(fn);
    if(fn==='reserve_platform_admin_reading'){
      const old=jobs.find(j=>j.input_summary.request_fingerprint===args.p_request_fingerprint && j.status!=='failed');
      if(old)return {data:{job:structuredClone(old),reused:true},error:null};
      const j={id:`job-${++next}`,workspace_id:'w',project_id:'p',file_id:'f',requested_by:'u',status:'processing',input_summary:{entitlement:'platform_admin_complimentary',file_sha256:args.p_file_sha256,request_fingerprint:args.p_request_fingerprint,requested_scope:args.p_scope,requested_trades:args.p_requested_trades},output_summary:{},plan_reading_findings:[]};
      jobs.push(j);return {data:{job:structuredClone(j),reused:false},error:null};
    }
    if(fn==='finish_platform_admin_reading'){
      const j=jobs.find(j=>j.id===args.p_job_id)!;
      j.status=args.p_error?'failed':'needs_review';j.output_summary=args.p_summary;j.plan_reading_findings=args.p_findings;
      return {data:structuredClone(j),error:null};
    }
    throw Error(fn);
  }};
  const reader:any={read:async(input:any)=>{
    reads.push(input);
    if(options.fail)throw Error('PRIVATE_PROVIDER_DETAIL');
    return {summary:{sheet_count:1,detected_trade_scope:['Framing'],scale_status:'missing',human_review_required:true,limitations:[]},findings:[{page_number:options.sourcePage??1,finding_type:'room',label:'Bedroom',quantity:100,unit:'SF',value_text:'100 SF',confidence:0.8,geometry:{},source_excerpt:'Bedroom 100 SF'}]};
  }};
  const service=new AiPlanReadingService(db,writer,{presign:()=>({url:'https://storage.test/test'})},reader,'u','w',(async()=>new Response(bytes))as typeof fetch,undefined,options.owner!==false);
  const input={file_id:'f',mode:'detailed',page_number:2,source_sha256:PDF_DIGEST(bytes),trades:['Framing'],scope:'New construction'};
  return {service,input,reads,jobs,calls,bytes};
}

test('page review sends just the requested physical page and rebases its saved evidence',async()=>{
  const h=await harness(); const result=await h.service.create('p',h.input);
  const supplied=await PDFDocument.load(h.reads[0].fileBytes);
  assert.equal(supplied.getPageCount(),1); assert.equal(supplied.getPage(0).getWidth(),220);
  assert.equal(result.plan_reading_findings[0].page_number,2);
  assert.equal(result.output_summary.physical_page_count,3);
  assert.equal(result.output_summary.physical_page_number,2);
  assert.equal(result.input_summary.page_strategy,'sheet-v1');
  assert.equal(h.reads[0].reasoningEffort,'high');
});

test('different pages receive distinct fingerprints; successful page reload never calls AI again',async()=>{
  const h=await harness(); await h.service.create('p',h.input);await h.service.create('p',h.input);
  await h.service.create('p',{...h.input,page_number:3});
  assert.equal(h.reads.length,2);assert.equal(h.jobs.length,2);
});

test('simultaneous same-page clicks authorize just one provider invocation',async()=>{
  const h=await harness();await Promise.all([h.service.create('p',h.input),h.service.create('p',h.input)]);
  assert.equal(h.reads.length,1);assert.equal(h.jobs.length,1);
});

for(const page_number of [0,4,2.5,'2',null])test(`reject invalid physical page ${page_number} before provider or reservation`,async()=>{
  const h=await harness();await assert.rejects(h.service.create('p',{...h.input,page_number}));
  assert.equal(h.reads.length,0);assert.equal(h.jobs.length,0);
});

test('changed source PDF and non-owner page requests never invoke a provider',async()=>{
  const h=await harness();await assert.rejects(h.service.create('p',{...h.input,source_sha256:'0'.repeat(64)}));assert.equal(h.reads.length,0);
  const other=await harness({owner:false});await assert.rejects(other.service.create('p',other.input));assert.equal(other.reads.length,0);
});

test('page-provider failure retains an unreplayable job and exposes no raw message',async()=>{
  const h=await harness({fail:true});await assert.rejects(h.service.create('p',h.input),e=>!String(e).includes('PRIVATE_PROVIDER_DETAIL'));
  await h.service.create('p',h.input);assert.equal(h.reads.length,1);
  assert.equal(h.jobs[0].status,'processing');assert.ok(h.jobs[0].processing_error);
});

test('cross-page output is rejected rather than relabeled as trustworthy',async()=>{
  const h=await harness({sourcePage:2});await assert.rejects(h.service.create('p',h.input));
  assert.equal(h.jobs[0].plan_reading_findings.length,0);
});

import { handleAiPlanRequest } from '../src/ai-plan/routes.ts';
test('a customer page request cannot fall through to paid, pilot or durable whole-file processing',async()=>{
  let invoked=false;
  const q:any={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:{is_platform_admin:false},error:null})};
  const response=await handleAiPlanRequest(new Request('https://app.test/api/projects/p/ai-plan-readings',{method:'POST',headers:{'x-workspace-id':'w','content-type':'application/json'},body:JSON.stringify({file_id:'f',page_number:1,quote_id:'q'})}),{auth:{getUser:async()=>({data:{user:{id:'customer'}},error:null})},from:()=>q}as never,{findingsWriter:{from:()=>({})},storage:{presign:()=>{invoked=true;return {url:'https://storage.test'};}},reader:{read:async()=>{invoked=true;throw Error();}},paidReaderAvailable:true});
  assert.equal(response.status,403);assert.equal(invoked,false);
});

test('a browser mode string cannot impersonate a physical-page fingerprint',async()=>{
  const h=await harness();
  const {page_number,source_sha256,...whole}=h.input;
  await h.service.create('p',{...whole,mode:'sheet-v1:2'});
  const specific=await h.service.create('p',h.input);
  assert.equal(h.reads.length,2);assert.equal(specific.output_summary.physical_page_number,2);
});
