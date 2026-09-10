import test from 'node:test';
import assert from 'node:assert/strict';
const domain = await import('../../../packages/domain/src/api-usage.ts').catch(() => ({} as any));
const metering = await import('../src/owner-usage/meter.ts').catch(() => ({} as any));
const routes = await import('../src/owner-usage/routes.ts').catch(() => ({} as any));
const now = new Date('2026-09-10T14:00:00Z');
const owner = { id: '86fb7719-0d1f-44fc-b68c-869b56ba74bd', email: 'kauan@kspdominion.group', email_confirmed_at: now.toISOString() };
const empty = { events: [], jobs: [], profiles: [], enrollments: [], invitations: [], cohorts: [], projects: [] };

test('absent telemetry is unknown, never verified zero expenditure', () => {
  assert.equal(typeof domain.buildUsageReport, 'function', 'The owner usage report must be implemented');
  const r = domain.buildUsageReport({ ...empty, jobs: [{ id:'legacy',requested_by:'u',status:'failed',model:'gemini-3.8-flash',created_at:now.toISOString() }] }, now);
  assert.equal(r.totals.actualCostUsd, null);
  assert.equal(r.totals.estimatedCostUsd, null);
  assert.equal(r.totals.unmeteredJobs, 1);
  assert.equal(r.users[0].userId, 'u');
});

test('cost estimates include thinking tokens, validate numbers, and expire rather than guessing', () => {
  assert.equal(typeof domain.measureGeminiUsage, 'function', 'Trusted provider token measurement must be implemented');
  const m = domain.measureGeminiUsage({promptTokenCount:32000,candidatesTokenCount:3000,thoughtsTokenCount:1096},'gemini-3.8-flash',now);
  assert.equal(m.outputTokens,4096); assert.equal(m.estimatedCostUsd,0.03936);
  assert.equal(domain.measureGeminiUsage({promptTokenCount:-1,candidatesTokenCount:2},'gemini-3.8-flash',now),null);
  assert.equal(domain.measureGeminiUsage({promptTokenCount:3,candidatesTokenCount:2},'other-model',now).estimatedCostUsd,null);
  assert.equal(domain.measureGeminiUsage({promptTokenCount:3,candidatesTokenCount:2},'gemini-3.8-flash',new Date('2027-01-01')).estimatedCostUsd,null);
});

test('per-user totals separate estimates, actual cost, pending exposure, and lifetime reservation', () => {
  const jobs=[{id:'job-1',requested_by:'u',status:'failed',created_at:now.toISOString()},{id:'job-2',requested_by:'v',status:'processing',created_at:now.toISOString()}];
  const events=[{id:'a',user_id:'u',provider:'gemini',model:'gemini-3.8-flash',operation:'rb1:job-1:generate:measured',input_tokens:100,output_tokens:30,estimated_cost_usd:0.000188,actual_cost_usd:null,created_at:now.toISOString()},
  {id:'b',user_id:'v',provider:'gemini',model:'gemini-3.8-flash',operation:'rb1:job-2:generate:pending',input_tokens:0,output_tokens:0,estimated_cost_usd:0,actual_cost_usd:null,created_at:now.toISOString()}];
  const r=domain.buildUsageReport({...empty,jobs,events,enrollments:[{user_id:'u',reserved_cents:25,expires_at:'2026-11-09',preset:'pilot60'}],cohorts:[{code:'founding-pilot-60d',capacity:25,budget_cents:10000,reserved_cents:25,enabled:true}]},now);
  assert.equal(r.totals.unmeteredJobs,0); assert.equal(r.totals.unknownCostEvents,1);
  assert.equal(r.totals.actualCostUsd,null); assert.equal(r.totals.estimatedCostUsd,0.000188);
  assert.equal(r.users.find((u:any)=>u.userId==='u').reservedCents,25);
  assert.equal(r.users.find((u:any)=>u.userId==='v').inputTokens,null);
  assert.equal(r.cohorts[0].budgetCents,10000); assert.equal(r.cohorts[0].maximumReservationCents,11250);
  assert.equal(r.cohorts[0].reservationShortfallCents,1250);
});

function meterDb(failInsert=false,failUpdate=false) {
  const rows:any[]=[]; const sequence:string[]=[];
  return {rows,sequence,writer:{from(table:string){assert.equal(table,'api_usage_events'); return {
    insert:async(row:any)=>{sequence.push('reserve');if(!failInsert)rows.push(row);return {error:failInsert?{message:'private db error'}:null};},
    update:(patch:any)=>({eq:async(_:string,id:string)=>{sequence.push('settle');if(!failUpdate)Object.assign(rows.find(r=>r.id===id),patch);return {error:failUpdate?{message:'private db error'}:null};}})
  };}}};
}
const context={userId:'u',workspaceId:'w',projectId:'p',jobId:'job-1',billing:'paid'};
test('trusted provider calls reserve before dispatch and settle from response metadata',async()=>{
  assert.equal(typeof metering.withUsageMeter,'function','Provider-boundary metering must be implemented');
  const d=meterDb();
  await metering.withUsageMeter({...context,writer:d.writer},()=>metering.meterGeminiCall('gemini-3.8-flash','generate',async()=>{d.sequence.push('provider');return {responseId:'response-1',usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:10}};}));
  assert.deepEqual(d.sequence,['reserve','provider','settle']);
  assert.equal(d.rows[0].output_tokens,30); assert.equal(d.rows[0].actual_cost_usd,null);
  assert.match(d.rows[0].operation,/:measured$/);
  assert.equal(JSON.stringify(d.rows).includes('fileBytes'),false);
});
test('complimentary app access does not zero provider cost estimates',async()=>{
  const d=meterDb();
  await metering.withUsageMeter({...context,billing:'verified_free',writer:d.writer},()=>metering.meterGeminiCall('gemini-3.8-flash','generate',async()=>({usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:10}})));
  assert.match(d.rows[0].operation,/:measured$/);
  assert.equal(d.rows[0].estimated_cost_usd,0.0001875);
  assert.equal(d.rows[0].actual_cost_usd,null);
});
test('database outage fails closed before consuming provider credit',async()=>{
  const d=meterDb(true);
  await assert.rejects(metering.withUsageMeter({...context,writer:d.writer},()=>metering.meterGeminiCall('gemini-3.8-flash','generate',async()=>{assert.fail('must not dispatch');})),/accounting/i);
  assert.deepEqual(d.sequence,['reserve']);
});
test('provider timeout remains unknown and is not refunded as zero',async()=>{
  const d=meterDb();
  await assert.rejects(metering.withUsageMeter({...context,writer:d.writer},()=>metering.meterGeminiCall('gemini-3.8-flash','generate',async()=>{throw new Error('timeout');})),/timeout/);
  assert.match(d.rows[0].operation,/:failed_unknown$/); assert.equal(d.rows[0].actual_cost_usd,null);
});
test('missing usage and settlement outages retain unknown or pending exposure',async()=>{
  const d=meterDb();await metering.withUsageMeter({...context,writer:d.writer},()=>metering.meterGeminiCall('gemini-3.8-flash','generate',async()=>({text:'bad JSON'})));
  assert.match(d.rows[0].operation,/:unknown$/);
  const e=meterDb(false,true);
  await assert.rejects(metering.withUsageMeter({...context,writer:e.writer},()=>metering.meterGeminiCall('gemini-3.8-flash','generate',async()=>({usageMetadata:{promptTokenCount:1,candidatesTokenCount:1}}))),/accounting/i);
  assert.match(e.rows[0].operation,/:pending$/);
});

function query(data:any) { const q:any={};for(const name of ['select','eq','gte','lt','order','range'])q[name]=()=>q;q.maybeSingle=async()=>({data,error:null});q.then=(resolve:any,reject:any)=>Promise.resolve({data,error:null}).then(resolve,reject);return q; }
const req=()=>new Request('https://roughbid.test/api/owner-usage?days=60');
test('only confirmed Kauan + fresh platform role can read cross-user financial data',async()=>{
  assert.equal(typeof routes.handleOwnerUsageRequest,'function','Owner-only endpoint must be implemented');
  for(const user of [null,{...owner,id:'other'}, {...owner,email:'attacker@example.com'},{...owner,email_confirmed_at:null}]) {
    let reads=0;const admin:any={from:()=>{reads++;throw new Error('must not read');}};
    const r=await routes.handleOwnerUsageRequest(req(),{auth:{getUser:async()=>({data:{user},error:null})}},admin);
    assert.ok([401,403].includes(r.status));assert.equal(reads,0);
  }
  const admin:any={from:(name:string)=>{assert.equal(name,'profiles');return query({is_platform_admin:false});}};
  const r=await routes.handleOwnerUsageRequest(req(),{auth:{getUser:async()=>({data:{user:owner},error:null})}},admin);
  assert.equal(r.status,403);assert.equal(r.headers.get('cache-control'),'no-store');
});
test('authorized report reads live cohort, sanitizes payloads, validates filters',async()=>{
  const admin:any={from:(name:string)=>name==='profiles'?query({is_platform_admin:true}):query([])};
  const auth:any={auth:{getUser:async()=>({data:{user:owner},error:null})}};
  assert.equal((await routes.handleOwnerUsageRequest(new Request('https://roughbid.test/api/owner-usage?days=-1'),auth,admin)).status,400);
  assert.equal((await routes.handleOwnerUsageRequest(new Request('https://roughbid.test/api/owner-usage',{method:'POST'}),auth,admin)).status,405);
});

test('concurrent users keep isolated attribution and independent attempt identities',async()=>{
  const d=meterDb();const seen:string[]=[];
  await Promise.all(['user-a','user-b'].map(userId=>metering.withUsageMeter({...context,userId,projectId:userId,writer:d.writer},()=>metering.meterGeminiCall('gemini-3.8-flash','generate',async()=>{await new Promise(r=>setTimeout(r,1));seen.push(userId);return {usageMetadata:{promptTokenCount:10,candidatesTokenCount:5}};}))));
  assert.equal(d.rows.length,2);assert.notEqual(d.rows[0].id,d.rows[1].id);
  assert.deepEqual(new Set(d.rows.map(r=>r.user_id)),new Set(seen));
  assert.ok(d.rows.every(r=>r.user_id===r.project_id && r.operation.endsWith(':measured')));
});

test('report endpoint never exposes prompts, secrets or token hashes and reads complete pages',async()=>{
  const tables:any={api_usage_events:[],plan_reading_jobs:[],profiles:[{id:owner.id,display_name:'Kauan'}],pilot_enrollments:[],pilot_invitations:[],pilot_cohorts:[{id:'c',code:'founding-pilot-60d',capacity:25,budget_cents:10000,reserved_cents:0,enabled:true}],pilot_project_creations:[]};
  const admin:any={from:(table:string)=>{const q=query(tables[table]);q.maybeSingle=async()=>({data:{is_platform_admin:true},error:null});return q;}};
  const auth:any={auth:{getUser:async()=>({data:{user:owner},error:null})}};
  const r=await routes.handleOwnerUsageRequest(req(),auth,admin);assert.equal(r.status,200);
  const payload=await r.json();assert.equal(payload.cohorts[0].budgetCents,10000);assert.equal(payload.users[0].email,owner.email);assert.equal(payload.totals.actualCostUsd,null);
  assert.equal(r.headers.get('cache-control'),'no-store');assert.doesNotMatch(JSON.stringify(payload),/token_hash|service_role|source_excerpt|input_summary/);
});

test('data query failures return no fabricated or partial totals',async()=>{
  const auth:any={auth:{getUser:async()=>({data:{user:owner},error:null})}};
  const admin:any={from:(table:string)=>{if(table==='profiles'){const q=query([]);q.maybeSingle=async()=>({data:{is_platform_admin:true},error:null});return q;}const q=query([]);q.then=(res:any)=>res({error:{message:'private database details'},data:null});return q;}};
  const response=await routes.handleOwnerUsageRequest(req(),auth,admin);assert.equal(response.status,503);
  assert.doesNotMatch(await response.text(),/private database details|actualCostUsd/);
});

test('actual Gemini SDK adapter records billable usage even when model JSON is malformed',async()=>{
  const {createGeminiClient,GeminiPlanReader}=await import('../src/ai-plan/gemini.ts');
  const d=meterDb();let calls=0;
  const client=await createGeminiClient('fixture-not-a-key',async()=>({GoogleGenAI:class {models={generateContent:async()=>{calls++;return {text:'not json',usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:10}};}};files={} as any;}}));
  const reader=new GeminiPlanReader(client,['gemini-3.8-flash']);
  await assert.rejects(metering.withUsageMeter({...context,writer:d.writer},()=>reader.read({fileBytes:new Uint8Array([1]),mimeType:'application/pdf',sheetName:'test.pdf',requestedTrades:[],scope:null})));
  assert.equal(calls,1);assert.equal(d.rows[0].output_tokens,30);assert.match(d.rows[0].operation,/:measured$/);
});

test('accounting failure cannot fan out to another configured Gemini model',async()=>{
  const {createGeminiClient,GeminiPlanReader}=await import('../src/ai-plan/gemini.ts');
  const d=meterDb(true);let calls=0;
  const client=await createGeminiClient('fixture-not-a-key',async()=>({GoogleGenAI:class {models={generateContent:async()=>{calls++;return {text:'{}'};}};files={} as any;}}));
  await assert.rejects(metering.withUsageMeter({...context,writer:d.writer},()=>new GeminiPlanReader(client,['gemini-3.8-flash','gemini-3.6-flash']).read({fileBytes:new Uint8Array([1]),mimeType:'application/pdf',sheetName:'test.pdf',requestedTrades:[],scope:null})),/accounting/i);
  assert.equal(calls,0);assert.equal(d.sequence.length,1);
});
