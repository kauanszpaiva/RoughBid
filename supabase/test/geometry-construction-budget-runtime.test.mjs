import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import {photoDatabase,USER,WORKSPACE,PROJECT} from '../../apps/api/test/helpers/photo-db.mjs';
import {handleGeometryRequest} from '../../apps/api/src/geometry/routes.ts';
import {GeometryProcessor} from '../../apps/api/src/geometry/worker.ts';
import {handleConstructionBudgetRequest} from '../../apps/api/src/construction-budget/routes.ts';
import researchData from '../../packages/domain/data/roughbid-catalog-base.json' with {type:'json'};
import {validateResearchConstructionCatalog,researchCatalogToConstructionCatalog} from '../../packages/domain/src/research-catalog.ts';

const FILE='30000000-0000-4000-8000-000000000080';
const REQUEST='40000000-0000-4000-8000-000000000080';
const OTHER_WORKSPACE='10000000-0000-4000-8000-000000000099';
const COMPONENT='RB-SITE-001.m01',ASSEMBLY='RB-SITE-001';
const AT='2026-10-03T00:50:00Z';
const LOCATION={country:'US',postalCode:'02110',storeId:'synthetic-store',timeZone:'America/New_York'};
const migrate=name=>readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const excluded=()=>({required:false,amount:null,refundable:false,sourceRef:'synthetic-supplier-document:explicit-exclusion'});
const quote=()=>({schema:'roughbid-supplier-quote-v1',id:'SYNTHETIC-Q96',supplier:'other',supplierName:'SYNTHETIC offline arithmetic fixture',location:LOCATION,
  sku:'synthetic-protection-box',variant:null,model:null,specification:'SYNTHETIC floor protection specification; no product quotation.',specificationReviewed:true,
  channel:'pickup',quotedQuantity:11,pricedUnit:'BOX',unitPrice:20,currency:'USD',origin:'manual_quote',sourceUrl:null,documentRef:'synthetic-supplier-document',
  observedAt:AT,evidenceAt:AT,sourceUpdatedAt:null,validUntil:'2026-10-04T00:00:00Z',importedAt:AT,reviewedBy:'spoofed-browser-reviewer',reviewedAt:AT,
  availability:'in_stock',availableQuantity:11,availabilityAt:AT,coveragePerPricedUnit:{quantity:100,unit:'SF'},unitsPerPackage:1,minimumOrderPackages:0,
  orderIncrement:1,roundingRule:'round_up_increment',charges:{freight:excluded(),handling:excluded(),tax:excluded(),conditionalDiscount:excluded(),refundableDeposit:excluded()}});

async function pdf(title='Synthetic PDF revision one') {
  const document=await PDFDocument.create(); document.addPage([600,400]);document.setTitle(title);return document.save();
}
function projectionAliases(client) {
  // Only translates Supabase's documented JSON select alias. SQL filters and data remain real.
  const original=client.from.bind(client);
  client.from=table=>{
    const query=original(table),select=query.select.bind(query),then=query.then.bind(query);let projection;
    query.select=columns=>{
      const fields=columns.split(',').map(field=>({field,alias:field.match(/^([a-z_]\w*):([a-z_]\w*)->([a-z_]\w*)$/i)}));
      if(!fields.some(field=>field.alias))return select(columns);projection=fields;
      return select([...new Set(fields.map(field=>field.alias?field.alias[2]:field.field))].join(','));
    };
    query.then=(resolve,reject)=>then(response=>{
      if(!projection||response.error)return resolve(response);
      const project=row=>row===null?null:Object.fromEntries(projection.map(({field,alias})=>alias?[alias[1],row[alias[2]]?.[alias[3]]??null]:[field,row[field]]));
      return resolve({...response,data:Array.isArray(response.data)?response.data.map(project):project(response.data)});
    },reject);return query;
  };
}
async function fixture({enabled=true}={}) {
  const database=await photoDatabase();let server;
  try {
    for(const migration of ['20261002140000_takeoff_measurement_review.sql','20261002170000_construction_budget.sql',
      '20261002180000_geometry_provider_jobs.sql','20261002190000_geometry_construction_budget.sql'])await database.sql.exec(migrate(migration));
    const state={bytes:await pdf(),revision:'SYNTHETIC-BLUEPRINT-R1',clock:Date.parse(AT),dropNextReviewResponse:false,dropNextBudgetResponse:false,
      vendorRequests:[],storageRequests:[],enqueued:[],consumerReady:true};
    const sourcePath=`${WORKSPACE}/${PROJECT}/${FILE}/source.pdf`;
    await database.sql.query('insert into project_files(id,workspace_id,project_id,storage_path,processing_status,page_count)values($1,$2,$3,$4,$5,$6)',
      [FILE,WORKSPACE,PROJECT,sourcePath,'ready',1]);
    await database.sql.exec(`create or replace function private.has_workspace_role(p_workspace uuid,p_roles text[]) returns boolean language sql stable security definer set search_path=public,auth,pg_temp
      as 'select exists(select 1 from workspace_members where workspace_id=p_workspace and user_id=auth.uid() and role=any(p_roles))';
      grant usage on schema private,auth to authenticated;grant execute on function auth.uid() to authenticated;`);
    projectionAliases(database.client);
    const storage={presign:async(method,key)=>{assert.equal(method,'GET');assert.equal(key,sourcePath);return {url:'https://private-storage.offline.test/source.pdf'};}};
    const fetcher=async(input,init={})=>{
      const url=new URL(input instanceof Request?input.url:String(input));
      if(url.origin==='https://private-storage.offline.test') {state.storageRequests.push(url.pathname);return new Response(state.bytes,{headers:{'content-type':'application/pdf'}});}
      // This transport never calls fetch: no vendor, storage or paid network request can escape.
      assert.equal(url.origin,'https://api.kamai.io');
      state.vendorRequests.push({method:init.method??'GET',path:url.pathname});
      if(url.pathname==='/v1/blueprints/upload') {
        assert.equal(init.method,'POST');const uploaded=init.body.get('file');assert.ok(uploaded instanceof Blob);
        const document=await PDFDocument.load(await uploaded.arrayBuffer());assert.equal(document.getPageCount(),1);
        return Response.json({project_id:'SYNTHETIC-KAMAI-PROJECT',job_id:'SYNTHETIC-KAMAI-JOB',upload_id:'SYNTHETIC-KAMAI-UPLOAD'});
      }
      if(url.pathname==='/v1/projects/SYNTHETIC-KAMAI-PROJECT/jobs/SYNTHETIC-KAMAI-JOB')return Response.json({job:{id:'SYNTHETIC-KAMAI-JOB',status:'CONFIRMED_FIXTURE',blueprint_id:'SYNTHETIC-BLUEPRINT'}});
      if(url.pathname==='/v1/blueprints/SYNTHETIC-BLUEPRINT')return Response.json({revision:state.revision,blueprint:{id:'SYNTHETIC-BLUEPRINT',
        scale:{ratio:'1:50',manual_scaling_needed:false},text:[],text_total:0,geojson:{type:'FeatureCollection',features:[{type:'Feature',
          geometry:{type:'Polygon',coordinates:[[[0,0],[12,0],[12,8],[0,8],[0,0]]]},properties:{id:'SYNTHETIC-ROOM-96',kind:'area',class:'room',sub_class:null,
            name:'Synthetic room96m2',relations:[],measurements:{area_m2:96,perimeter_m:40,length_m:null,opening_width_m:null}}}]}}});
      throw new Error(`Unexpected offline vendor path: ${url.pathname}`);
    };
    const profile={version:'geometry-provider-v1',profileHash:'a'.repeat(64),kamai:{apiKey:'synthetic-offline-test',enabled:true,integrationApproved:true,dataOemAuthorized:true,
      jobSuccessStatus:'CONFIRMED_FIXTURE',jobSuccessStatusVerified:true,pollIntervalMs:1000},approvedRunBudgetUsd:20,maximumCallCostUsd:1,maximumCalls:20,
      approvalRef:'synthetic-offline-test-authorization',pollIntervalMs:1000};
    const queue={isWorkerAvailable:async()=>state.consumerReady,add:async(name,data,options)=>{assert.equal(name,'read-geometry');assert.equal(options.attempts,1);state.enqueued.push({data:structuredClone(data),options});}};
    const dependencies={writer:database.client,storage,queue,fetcher,...(enabled?{profile}:{})};
    const processor=new GeometryProcessor(database.client,storage,profile,'synthetic-geometry-worker',queue,fetcher,()=>new Date(state.clock));
    await processor.touch();
    server=createServer(async(incoming,outgoing)=>{
      try {
        const chunks=[];for await(const chunk of incoming)chunks.push(chunk);
        const body=Buffer.concat(chunks),headers=new Headers();for(const [name,value]of Object.entries(incoming.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(','):value);
        const request=new Request(`http://127.0.0.1${incoming.url}`,{method:incoming.method,headers,...(body.byteLength?{body}:{})});
        const geometry=String(incoming.url).includes('/geometry/');
        const response=geometry?await handleGeometryRequest(request,database.client,dependencies):await handleConstructionBudgetRequest(request,database.client,database.client,()=>AT);
        if(state.dropNextReviewResponse&&incoming.method==='POST'&&String(incoming.url).endsWith('/review')) {state.dropNextReviewResponse=false;incoming.socket.destroy();return;}
        if(state.dropNextBudgetResponse&&incoming.method==='POST'&&String(incoming.url).endsWith('/construction-budget')) {state.dropNextBudgetResponse=false;incoming.socket.destroy();return;}
        outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(Buffer.from(await response.arrayBuffer()));
      }catch(error){outgoing.writeHead(500,{'content-type':'application/json'});outgoing.end(JSON.stringify({fixtureError:error.message}));}
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const base=`http://127.0.0.1:${server.address().port}/api/projects/${PROJECT}`;
    const send=(endpoint,method='GET',body,workspace=WORKSPACE)=>fetch(`${base}/${endpoint}`,{method,headers:{...(workspace?{'x-workspace-id':workspace}:{}),
      ...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const close=async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await database.close();};
    return {...database,state,send,dependencies,processor,close};
  }catch(error){server?.closeAllConnections();server?.close();await database.close();throw error;}
}
async function json(response,status) {const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;}
async function reserve(f,requestKey=REQUEST) {return json(await f.send('geometry/runs','POST',{provider:'kamai',fileId:FILE,physicalPageNumber:1,requestKey}),202);}
async function processToReview(f,runId) {
  for(let tick=0;tick<6;tick++) {
    f.state.clock+=2000;
    await f.processor.process({data:{runId,version:'geometry-provider-v1'}});
    const saved=(await f.sql.query('select status from geometry_provider_jobs where id=$1',[runId])).rows[0];
    if(saved.status==='needs_review')return;
    assert.equal(saved.status,'waiting');
  }assert.fail('Offline geometry never reached review.');
}
function review(candidateId,requestKey=crypto.randomUUID(),expectedRevision=0) {return {candidateId,requestKey,expectedRevision,decision:'accepted',identityReviewed:true,geometryReviewed:true,
  duplicateReviewComplete:true,reviewNote:'Synthetic test: reviewed source SI, geometry identity and duplicates.'};}
function budget(runId,candidateId) {
  const catalog=researchCatalogToConstructionCatalog(validateResearchConstructionCatalog(researchData)),material=structuredClone(catalog.items.find(item=>item.id===COMPONENT));
  Object.assign(material,{reviewed:true,specification:quote().specification,specificationSource:{name:'SYNTHETIC specification',url:null,documentRef:'synthetic-product-doc',effectiveDate:'2026-10-02',place:'US 02110'},
    rate:{amount:999999,source:null,reviewed:true},wastePercent:0,pack:{pricedUnit:'BOX',coverageQuantity:100,coverageUnit:'SF',unitsPerPackage:1,minimumOrderPackages:0,orderIncrement:1,roundingRule:'round_up_increment'}});
  return {sourceKind:'geometry',runId,location:LOCATION,quoteIds:['SYNTHETIC-Q96'],selections:[{measurementId:candidateId,assemblyId:ASSEMBLY,quantity:999999,quantitySI:999999,unit:'SF',
    activation:{[COMPONENT]:true,'RB-SITE-001.m02':false},componentInputs:{}}],catalogOverrides:{schema:catalog.schema,items:[material]},
    quoteBindings:[{componentId:COMPONENT,quoteId:'SYNTHETIC-Q96',supplier:'other',sku:quote().sku,variant:null,channel:'pickup',specificationReviewed:true}]};
}

test('real HTTP geometry→mock Kamai→SQL review→construction snapshot/reload preserves96m2 and converts toSF exactly once',async()=>{
  const f=await fixture();try {
    const capability=await json(await f.send('geometry/capability'),200);assert.equal(capability.workerReady,true);
    const reserved=await reserve(f);assert.equal(reserved.run.file_sha256,hash(f.state.bytes));assert.equal(reserved.replayed,false);
    await processToReview(f,reserved.run.id);
    const detected=await json(await f.send(`geometry/runs/${reserved.run.id}`),200),candidate=detected.candidates.find(item=>item.measurementKind==='area');
    assert.ok(candidate);assert.equal(candidate.status,'candidate');assert.equal(candidate.quantity,96);assert.equal(candidate.unit,'m2');assert.equal(candidate.source.scale.ratio,'1:50');
    assert.deepEqual(candidate.geometry,{type:'Polygon',coordinates:[[[0,0],[12,0],[12,8],[0,8],[0,0]]]});assert.equal(detected.coverage.complete,false);
    const storedCandidate=(await f.sql.query('select candidate,status from geometry_provider_candidates where id=$1',[candidate.id])).rows[0];assert.equal(storedCandidate.candidate.quantity,96);
    const approved=await json(await f.send(`geometry/runs/${reserved.run.id}/review`,'POST',{...review(candidate.id),quantity:999999,quantitySI:999999}),200);
    assert.equal(approved.candidate.quantity,96);assert.equal(approved.candidate.reviewRevision,1);
    await json(await f.send('supplier-quotes','POST',{quotes:[quote()]}),201);
    const created=await json(await f.send('construction-budget','POST',budget(reserved.run.id,candidate.id)),201);
    assert.equal(created.sourceKind,'geometry');assert.equal(created.result.knownSubtotalUsd,220);assert.equal(created.result.totalUsd,null);assert.equal(created.result.coverage,'partial');
    const measurement=created.result.trace[0].measurement;
    assert.equal(measurement.sourceKind,'geometry');assert.equal(measurement.quantity,1033.3354);assert.equal(measurement.unit,'SF');assert.equal(measurement.sourceEvidence.quantitySI,96);
    assert.equal(measurement.sourceEvidence.unitSI,'m2');assert.match(measurement.sourceEvidence.conversion,/0\.09290304/);assert.equal(measurement.sourceEvidence.source.revision,'SYNTHETIC-BLUEPRINT-R1');
    assert.equal(created.result.lines.find(line=>line.itemId===COMPONENT).quantity,11);assert.equal(created.result.quoteStates[0].evaluation.state,'fresh');
    assert.ok(created.result.fiscal.pendingNodes.some(node=>node.code==='quote_tax_inclusion_review_pending'));
    const sqlSnapshot=(await f.sql.query('select geometry_run_id,plan_run_id,photo_run_id,inputs,result from construction_budget_snapshots where id=$1',[created.id])).rows[0];
    assert.equal(sqlSnapshot.geometry_run_id,reserved.run.id);assert.equal(sqlSnapshot.plan_run_id,null);assert.equal(sqlSnapshot.photo_run_id,null);
    assert.equal(sqlSnapshot.inputs.selections[0].quantity,999999);assert.equal(sqlSnapshot.result.trace[0].measurement.quantity,1033.3354);
    const restored=await json(await f.send(`construction-budget?snapshot_id=${created.id}`),200);
    assert.deepEqual(restored.snapshots.find(snapshot=>snapshot.id===created.id).result,created.result);
    assert.equal(restored.measurements.find(item=>item.id===candidate.id).sourceEvidence.quantitySI,96);
    assert.deepEqual(f.state.vendorRequests.map(request=>request.method),['POST','GET','GET']);
    assert.equal((await f.sql.query('select count(*)::int as count from geometry_provider_spend_reservations')).rows[0].count,3);
  }finally{await f.close();}
});

test('closed geometry capability/queue/spend and workspace/viewer gates send no vendor request',async()=>{
  const disabled=await fixture({enabled:false});try {
    const capability=await json(await disabled.send('geometry/capability'),200);assert.equal(capability.enabled,false);
    await json(await disabled.send('geometry/runs','POST',{provider:'kamai',fileId:FILE,physicalPageNumber:1,requestKey:REQUEST}),503);
    assert.equal(disabled.state.vendorRequests.length,0);assert.equal(disabled.state.enqueued.length,0);
    assert.equal((await disabled.sql.query('select count(*)::int as count from geometry_provider_jobs')).rows[0].count,0);
  }finally{await disabled.close();}
  const f=await fixture();try {
    f.state.consumerReady=false;await json(await f.send('geometry/runs','POST',{provider:'kamai',fileId:FILE,physicalPageNumber:1,requestKey:REQUEST}),503);f.state.consumerReady=true;
    await json(await f.send('geometry/capability','GET',undefined,OTHER_WORKSPACE),403);
    await f.sql.query('update workspace_members set role=$1 where workspace_id=$2 and user_id=$3',['viewer',WORKSPACE,USER]);
    await json(await f.send('geometry/runs','POST',{provider:'kamai',fileId:FILE,physicalPageNumber:1,requestKey:REQUEST}),403);
    await json(await f.send('construction-budget','POST',{sourceKind:'geometry',runId:REQUEST,selections:[],quoteIds:[]}),403);
    await f.sql.query('update workspace_members set role=$1 where workspace_id=$2 and user_id=$3',['estimator',WORKSPACE,USER]);
    const reserved=await reserve(f);await f.sql.exec('update provider_spend_policy set enabled=false');
    await assert.rejects(f.processor.process({data:{runId:reserved.run.id,version:'geometry-provider-v1'}}),/company_spend_blocked/);
    assert.equal(f.state.vendorRequests.length,0);assert.equal((await f.sql.query('select count(*)::int as count from geometry_provider_spend_reservations')).rows[0].count,0);
    const blocked=(await f.sql.query('select status from geometry_provider_jobs where id=$1',[reserved.run.id])).rows[0];assert.equal(blocked.status,'blocked');
  }finally{await f.close();}
});

test('lost HTTP approval/snapshot ACK replays SQL receipts without accepting twice or making another priced snapshot',async()=>{
  const f=await fixture();try {
    const first=await reserve(f),replayed=await reserve(f);assert.equal(replayed.run.id,first.run.id);assert.equal(replayed.replayed,true);
    await processToReview(f,first.run.id);
    const detected=await json(await f.send(`geometry/runs/${first.run.id}`),200),candidate=detected.candidates.find(item=>item.measurementKind==='area'),decision=review(candidate.id);
    f.state.dropNextReviewResponse=true;await assert.rejects(f.send(`geometry/runs/${first.run.id}/review`,'POST',decision));
    const approved=await json(await f.send(`geometry/runs/${first.run.id}/review`,'POST',decision),200);
    assert.equal(approved.replayed,true);assert.equal(approved.candidate.reviewRevision,1);
    assert.equal((await f.sql.query('select count(*)::int as count from geometry_provider_review_receipts')).rows[0].count,1);
    assert.equal((await f.sql.query('select review_revision from geometry_provider_candidates where id=$1',[candidate.id])).rows[0].review_revision,1);
    await json(await f.send('supplier-quotes','POST',{quotes:[quote()]}),201);
    const body=budget(first.run.id,candidate.id);f.state.dropNextBudgetResponse=true;await assert.rejects(f.send('construction-budget','POST',body));
    const recovered=await json(await f.send('construction-budget','POST',body),201);
    assert.equal((await f.sql.query('select count(*)::int as count from construction_budget_snapshots')).rows[0].count,1);
    const history=await json(await f.send(`construction-budget?snapshot_id=${recovered.id}`),200);assert.deepEqual(history.snapshots[0].result,recovered.result);
    assert.equal(f.state.vendorRequests.filter(request=>request.method==='POST').length,1);
  }finally{await f.close();}
});

test('new private PDF revision invalidates accepted geometry while immutable earlier budget evidence remains readable',async()=>{
  const f=await fixture();try {
    const original=await reserve(f);await processToReview(f,original.run.id);
    const detected=await json(await f.send(`geometry/runs/${original.run.id}`),200),candidate=detected.candidates.find(item=>item.measurementKind==='area');
    await json(await f.send(`geometry/runs/${original.run.id}/review`,'POST',review(candidate.id)),200);
    await json(await f.send('supplier-quotes','POST',{quotes:[quote()]}),201);
    const snapshot=await json(await f.send('construction-budget','POST',budget(original.run.id,candidate.id)),201);
    f.state.bytes=await pdf('Synthetic PDF revision two');f.state.revision='SYNTHETIC-BLUEPRINT-R2';
    const changed=await reserve(f,crypto.randomUUID());assert.notEqual(changed.run.id,original.run.id);assert.notEqual(changed.run.file_sha256,original.run.file_sha256);
    const invalidated=(await f.sql.query('select status,review_revision,candidate from geometry_provider_candidates where id=$1 and run_id=$2',[candidate.id,original.run.id])).rows[0];
    assert.notEqual(invalidated.status,'accepted','Old accepted quantity must not survive a new source PDF revision.');
    const current=await json(await f.send('construction-budget'),200);assert.equal(current.measurements.some(value=>value.id===candidate.id),false);
    await json(await f.send('construction-budget','POST',budget(original.run.id,candidate.id)),422);
    const frozen=await json(await f.send(`construction-budget?snapshot_id=${snapshot.id}`),200);
    assert.equal(frozen.snapshots.find(value=>value.id===snapshot.id).result.trace[0].measurement.sourceEvidence.quantitySI,96);
    assert.equal(f.state.vendorRequests.filter(request=>request.method==='POST').length,1,'Reserving a revised source does not upload it.');
  }finally{await f.close();}
});
