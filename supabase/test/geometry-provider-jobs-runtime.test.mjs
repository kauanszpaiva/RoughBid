import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {PDFDocument} from 'pdf-lib';
import {photoDatabase,USER,WORKSPACE,PROJECT} from '../../apps/api/test/helpers/photo-db.mjs';
import {GeometryProcessor} from '../../apps/api/src/geometry/worker.ts';import {handleGeometryRequest} from '../../apps/api/src/geometry/routes.ts';
const FILE='30000000-0000-4000-8000-000000000081',PARENT='40000000-0000-4000-8000-000000000081';
const polygon={type:'Polygon',coordinates:[[[0,0],[2,0],[2,1],[0,1],[0,0]]]};
const PROFILE={version:'geometry-provider-v1',profileHash:'c'.repeat(64),kamai:{apiKey:'synthetic-unit-test',enabled:true,integrationApproved:true,dataOemAuthorized:true,
  jobSuccessStatus:'OFFLINE_CONFIRMED',jobSuccessStatusVerified:true,pollIntervalMs:1000},approvedRunBudgetUsd:20,maximumCallCostUsd:1,maximumCalls:20,approvalRef:'offline-only-approval',pollIntervalMs:1000};
async function fixture(options={}){
  const f=await photoDatabase();try{
    await f.sql.exec(readFileSync(new URL('../migrations/20261002180000_geometry_provider_jobs.sql',import.meta.url),'utf8'));
    const pdf=await PDFDocument.create();pdf.addPage([100,100]);if(options.pages===2)pdf.addPage([100,100]);const bytes=await pdf.save(),hash=createHash('sha256').update(bytes).digest('hex');
    await f.sql.query('insert into project_files(id,workspace_id,project_id,storage_path,processing_status,page_count) values($1,$2,$3,$4,$5,$6)',[FILE,WORKSPACE,PROJECT,`${WORKSPACE}/${PROJECT}/${FILE}/source.pdf`,'ready',options.pages??1]);
    const calls=[],queued=[],profile={...PROFILE,...options.profile};let ms=0;
    const queue={async isWorkerAvailable(){return true;},async add(name,data,opts){queued.push({name,data,opts});}};
    const word=id=>({id:String(id),text:`word-${id}`,confidence:0.99,geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,1],[0,0]]]}});
    const fetcher=async(input,init)=>{const url=new URL(String(input));if(url.hostname==='private.local')return new Response(bytes);calls.push({url:url.pathname,method:init?.method??'GET'});
      if(url.pathname.endsWith('/upload'))return Response.json({project_id:'provider-project',job_id:'provider-job',upload_id:'provider-upload'});
      if(url.pathname.includes('/jobs/'))return Response.json({job:{id:'provider-job',status:'OFFLINE_CONFIRMED',blueprint_id:'blueprint'}});
      const offset=Number(url.searchParams.get('text_offset'));const count=options.textTotal??0;
      return Response.json({revision:'revision-1',blueprint:{id:'blueprint',scale:{manual_scaling_needed:false,drawing_scale:'1:50'},geojson:{type:'FeatureCollection',features:[{type:'Feature',geometry:polygon,properties:{id:'room',kind:'area',class:'room',measurements:{area_m2:2,perimeter_m:6}}}]},
        text:count?Array.from({length:Math.min(1000,count-offset)},(_,i)=>word(offset+i)):[],text_total:count}});};
    const storage={async presign(){return {url:'https://private.local/source.pdf',method:'GET',headers:{},expiresAt:new Date().toISOString()};}};
    const processor=new GeometryProcessor(f.client,storage,profile,'offline-geometry-worker',queue,fetcher,()=>new Date(Date.now()+ms));await processor.touch();
    const request=(path,body,method='POST')=>handleGeometryRequest(new Request(`https://roughbid.local/api/projects/${PROJECT}/geometry/${path}`,{method,headers:{'x-workspace-id':WORKSPACE,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),f.client,{writer:f.client,storage,profile,queue,fetcher});
    const reserve=async(overrides={})=>{const response=await request('runs',{provider:'kamai',fileId:FILE,fileSha256:hash,physicalPageNumber:1,requestKey:crypto.randomUUID(),...overrides});return {status:response.status,...await response.json()};};
    const tick=async(runId)=>{ms+=5000;return processor.process({data:{runId,version:'geometry-provider-v1'}});};
    return {...f,request,reserve,tick,processor,queued,calls,hash,profile};
  }catch(error){await f.close();throw error;}
}
test('Kamai OCR pagination remains durably waiting until ALL words are persisted; restart does not reupload',async()=>{const f=await fixture({textTotal:1001});try{
  const saved=await f.reserve();assert.equal(saved.status,202);const id=saved.run.id;
  await f.tick(id);await f.tick(id);const third=await f.tick(id);assert.equal(third.status,'waiting');
  const pending=(await f.sql.query('select status,checkpoint from geometry_provider_jobs where id=$1',[id])).rows[0];assert.equal(pending.checkpoint.state,'awaiting_text');assert.equal(pending.checkpoint.textOffset,1000);
  assert.equal((await f.sql.query('select count(*)::int as count from geometry_provider_candidates')).rows[0].count,0);
  const final=await f.tick(id);assert.equal(final.status,'needs_review');const complete=(await f.sql.query('select checkpoint from geometry_provider_jobs where id=$1',[id])).rows[0].checkpoint;
  assert.equal(complete.textOffset,1001);assert.equal(complete.evidence.text.length,1001);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
}finally{await f.close();}});
test('Recovery enqueues saved queue-ACK gaps with stable identity and never calls providers',async()=>{const f=await fixture();try{
  const saved=await f.reserve();const initial=f.queued.length;assert.equal(await f.processor.recover(),1);assert.equal(await f.processor.recover(),1);
  assert.equal(f.queued.length,initial+2);assert.equal(f.queued.at(-1).opts.jobId,f.queued.at(-2).opts.jobId);assert.equal(f.calls.length,0);
  await f.tick(saved.run.id);const before=f.calls.length;assert.equal(await f.processor.recover(),0); // future tick is not dispatched early
  await f.sql.query(`update geometry_provider_jobs set checkpoint=jsonb_set(checkpoint,'{nextPollAt}',to_jsonb((now()-interval '2 seconds')::text)) where id=$1`,[saved.run.id]);
  assert.equal(await f.processor.recover(),1);assert.equal(f.calls.length,before);assert.equal(f.queued.at(-1).opts.removeOnFail,true);
}finally{await f.close();}});
test('Full-parent cancel atomically cancels child work with feature flag off and consent revoked',async()=>{const f=await fixture();try{
  await f.sql.query(`insert into takeoff_runs(id,workspace_id,project_id,file_id,mode,file_sha256,orchestrator_version,requested_by,status)values($1,$2,$3,$4,'full',$5,'takeoff-v2.2-durable',$6,'queued')`,[PARENT,WORKSPACE,PROJECT,FILE,f.hash,USER]);
  const saved=await f.reserve({parentRunId:PARENT});assert.equal(saved.status,202);
  await f.sql.query('update workspaces set ai_processing_consented_at=null where id=$1',[WORKSPACE]);
  const cancelled=await f.client.rpc('cancel_full_takeoff_v2',{p_run_id:PARENT,p_user_id:USER,p_workspace_id:WORKSPACE});assert.equal(cancelled.error,null);assert.equal(cancelled.data.geometryJobsCancelled,1);
  const child=(await f.sql.query('select status,cancel_requested_at from geometry_provider_jobs where id=$1',[saved.run.id])).rows[0];assert.equal(child.status,'cancelled');assert.ok(child.cancel_requested_at);
  assert.equal((await f.tick(saved.run.id)).skip,true);assert.equal(f.calls.length,0);
}finally{await f.close();}});
test('Existing standalone same page cannot be reused unbound by a Full parent or silently reuploaded',async()=>{const f=await fixture();try{
  const standalone=await f.reserve();assert.equal(standalone.status,202);
  await f.sql.query(`insert into takeoff_runs(id,workspace_id,project_id,file_id,mode,file_sha256,orchestrator_version,requested_by,status)values($1,$2,$3,$4,'full',$5,'takeoff-v2.2-durable',$6,'queued')`,[PARENT,WORKSPACE,PROJECT,FILE,f.hash,USER]);
  const child=await f.reserve({parentRunId:PARENT});assert.equal(child.status,409);assert.equal((await f.sql.query('select count(*)::int as count from geometry_provider_jobs')).rows[0].count,1);assert.equal(f.calls.length,0);
}finally{await f.close();}});
test('Document budget/call allowance is shared by ALL physical page jobs instead of multiplied per page',async()=>{const f=await fixture({pages:2,profile:{approvedRunBudgetUsd:3,maximumCalls:3}});try{
  const page1=await f.reserve(),page2=await f.reserve({physicalPageNumber:2});assert.equal(page1.status,202);assert.equal(page2.status,202);
  await f.tick(page1.run.id);await f.tick(page2.run.id);await f.tick(page1.run.id);
  // The adapter conservatively records a failed poll when pre-dispatch budget is exhausted; no fourth HTTP is sent.
  await assert.rejects(()=>f.tick(page2.run.id),/geometry_run_spend_blocked/);assert.equal(f.calls.length,3);const used=(await f.sql.query('select count(*)::int as count,sum(reserved_usd)::numeric as spent from geometry_provider_spend_reservations')).rows[0];assert.equal(used.count,3);assert.equal(Number(used.spent),3);
  assert.equal((await f.sql.query('select status from geometry_provider_jobs where id=$1',[page2.run.id])).rows[0].status,'blocked');
}finally{await f.close();}});
test('Geometry exposure is included in shared LLM/photo company breakers, with unknown tariff held conservatively',async()=>{const f=await fixture();try{
  const saved=await f.reserve();await f.tick(saved.run.id);await f.tick(saved.run.id);await f.sql.exec('update provider_spend_policy set spend_cap_usd=4');
  const base={p_event_id:crypto.randomUUID(),p_workspace_id:WORKSPACE,p_user_id:USER,p_provider:'gemini',p_model:'synthetic-model'};
  const llm=await f.client.rpc('reserve_provider_spend',{...base,p_job_id:crypto.randomUUID()});assert.match(llm.error.message,/Company AI spend limit reached/);
  const photo=await f.client.rpc('reserve_photo_provider_spend',{...base,p_event_id:crypto.randomUUID(),p_run_id:crypto.randomUUID(),p_lease_id:crypto.randomUUID(),p_asset_id:crypto.randomUUID()});assert.match(photo.error.message,/Company AI spend limit reached/);
  assert.equal(f.calls.length,2);const receipt=(await f.sql.query('select telemetry_known,estimated_cost_usd from geometry_provider_spend_reservations limit 1')).rows[0];assert.equal(receipt.telemetry_known,false);assert.equal(receipt.estimated_cost_usd,null);
}finally{await f.close();}});
test('Native CAD/BIM product route→APS adapter→metadata/properties→SQL SI candidates runs offline; caller source claims alone are blocked',async()=>{
  const f=await photoDatabase();try{
    await f.sql.exec(readFileSync(new URL('../migrations/20261002180000_geometry_provider_jobs.sql',import.meta.url),'utf8'));
    const objectId='urn:adsk.objects:os.object:roughbid-fixture/model.ifc',hash='a'.repeat(64),urn=Buffer.from(objectId).toString('base64url');
    const profile={...PROFILE,kamai:undefined,aps:{clientId:'synthetic-client',clientSecret:'synthetic-secret',enabled:true,integrationApproved:true,dataAuthorized:true,pollIntervalMs:1000},
      apsSourceBindings:[{projectId:PROJECT,objectId,sourceVersion:'v1',fileSha256:hash,proofRef:'synthetic-signed-source-manifest',reviewed:true}]};
    const calls=[],queue={async isWorkerAvailable(){return true;},async add(){}};
    const storage={async presign(){throw new Error('APS must not download/upload PDFs');}};
    const fetcher=async(input,init)=>{const url=new URL(String(input));calls.push(url.pathname);assert.equal(init.redirect,'manual');
      if(url.pathname.endsWith('/token'))return Response.json({access_token:'synthetic-token',token_type:'Bearer',expires_in:3600});
      if(url.pathname.endsWith('/job'))return Response.json({result:'success'},{status:201});
      if(url.pathname.endsWith('/manifest'))return Response.json({urn,status:'success',derivatives:[{outputType:'svf2',status:'success',children:[]}]});
      if(url.pathname.endsWith('/properties'))return Response.json({data:{collection:[{objectid:7,name:'Native floor',properties:{Dimensions:{Area:'100 ft^2',Length:{value:1000,unit:'mm'}}}}]}});
      return Response.json({data:{metadata:[{guid:'view-1',name:'Geometry fixture'}]}});
    };
    const processor=new GeometryProcessor(f.client,storage,profile,'offline-aps-worker',queue,fetcher);await processor.touch();
    const input={provider:'aps',sourceFormat:'ifc',objectId,sourceVersion:'v1',fileSha256:hash,requestKey:crypto.randomUUID()};
    const request=async(body,configured=profile)=>handleGeometryRequest(new Request(`https://roughbid.local/api/projects/${PROJECT}/geometry/runs`,{method:'POST',headers:{'x-workspace-id':WORKSPACE,'Content-Type':'application/json'},body:JSON.stringify(body)}),f.client,{writer:f.client,storage,profile:configured,queue,fetcher});
    const unbound=await request(input,{...profile,apsSourceBindings:[]});assert.equal(unbound.status,503);assert.equal(calls.length,0);
    const reserved=await request(input);assert.equal(reserved.status,202);const run=(await reserved.json()).run;
    await processor.process({data:{runId:run.id,version:'geometry-provider-v1'}});await processor.process({data:{runId:run.id,version:'geometry-provider-v1'}});const result=await processor.process({data:{runId:run.id,version:'geometry-provider-v1'}});
    assert.equal(result.status,'needs_review');const candidates=(await f.sql.query('select candidate,status from geometry_provider_candidates where run_id=$1',[run.id])).rows;
    assert.equal(candidates.length,2);const area=candidates.find(c=>c.candidate.unit==='m2');assert.equal(area.candidate.quantity,9.290304);assert.equal(area.candidate.source.unitEvidence,'ft^2');
    assert.equal(candidates.find(c=>c.candidate.unit==='m').candidate.quantity,1);assert.ok(candidates.every(c=>c.status==='candidate'));assert.ok(calls.every(path=>!path.includes('blueprints/upload')));
  }finally{await f.close();}
});
