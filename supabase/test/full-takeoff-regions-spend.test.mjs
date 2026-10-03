import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const ids={user:'00000000-0000-4000-8000-000000000001',workspace:'10000000-0000-4000-8000-000000000001',
  project:'20000000-0000-4000-8000-000000000001',file:'30000000-0000-4000-8000-000000000001'};
const migration=name=>readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
async function fixture(){
  const db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema private;
    create table auth.users(id uuid primary key);create table profiles(id uuid primary key,is_platform_admin boolean);
    create table workspaces(id uuid primary key,ai_processing_consented_at timestamptz);create table workspace_members(workspace_id uuid,user_id uuid,role text);
    create table projects(id uuid primary key,workspace_id uuid,unique(id,workspace_id));
    create table project_files(id uuid primary key,workspace_id uuid,project_id uuid,storage_path text,processing_status text,page_count integer,unique(id,workspace_id,project_id));
    create function auth.uid() returns uuid language sql stable as 'select null::uuid';
    create function private.has_workspace_role(uuid,text[]) returns boolean language sql stable as 'select true';
    create function private.has_product_access() returns boolean language sql stable as 'select true';
    create table plan_reading_jobs(id uuid primary key,workspace_id uuid,project_id uuid,requested_by uuid);
    create table api_usage_events(id uuid primary key,workspace_id uuid,project_id uuid,user_id uuid,provider text,model text,operation text);
    create table provider_spend_policy(singleton boolean primary key,enabled boolean,rolling_window interval,spend_cap_usd numeric,call_reservation_usd numeric);
    insert into provider_spend_policy values(true,true,interval '24 hours',100,2.5);
    create table provider_spend_reservations(event_id uuid primary key references api_usage_events(id),job_id uuid not null references plan_reading_jobs(id),workspace_id uuid references workspaces(id),user_id uuid,provider text,model text,status text default 'reserved',reserved_usd numeric,estimated_cost_usd numeric,telemetry_known boolean default false,created_at timestamptz default now());
    insert into auth.users values('${ids.user}');insert into profiles values('${ids.user}',true);insert into workspaces values('${ids.workspace}',now());
    insert into workspace_members values('${ids.workspace}','${ids.user}','estimator');insert into projects values('${ids.project}','${ids.workspace}');
    insert into project_files values('${ids.file}','${ids.workspace}','${ids.project}','${ids.workspace}/${ids.project}/${ids.file}/source.pdf','ready',1);`);
  for(const file of ['20260910225937_takeoff_v2_foundation.sql','20261002120000_full_takeoff_v2_durable.sql',
    '20261002150000_full_takeoff_regions.sql','20261002160000_full_takeoff_run_budgets.sql']) await db.exec(migration(file));
  await db.query('select touch_full_takeoff_v2_worker($1,$2)',['offline-worker','takeoff-v2.2-durable']);
  const manifest={fileSha256:'a'.repeat(64),physicalPageCount:1,sheets:[{physicalPageNumber:1,pageSha256:'b'.repeat(64),widthPoints:200,heightPoints:100,rotationDegrees:0,contentKind:'vector',textQuality:'good'}]};
  const run=(await db.query('select reserve_full_takeoff_v2($1,$2,$3,$4,$5,$6) as r',
    [ids.user,ids.workspace,ids.project,ids.file,JSON.stringify(manifest),'takeoff-v2.2-durable'])).rows[0].r.run;
  const claim=(await db.query('select claim_full_takeoff_v2($1,$2,$3) as c',[run.id,'offline-worker','takeoff-v2.2-durable'])).rows[0].c;
  return {db,run,lease:claim.lease_id};
}
const region={x:0,y:47,width:106,height:53,column:1,row:1,columns:2,rows:2};
async function beginParent(db,run,lease){await db.query("select begin_full_takeoff_v2_pass($1,$2,1,'discipline',1,$3)",[run.id,lease,'c'.repeat(64)]);}
async function beginRegion(db,run,lease,rectangle=region){return (await db.query('select begin_full_takeoff_region($1,$2,1,$3,$4,$5,$6,$7) as r',
  [run.id,lease,'b'.repeat(64),'discipline','r1c1g2',JSON.stringify(rectangle),'d'.repeat(64)])).rows[0].r;}
async function configure(db,run,lease,amount=5){return db.query('select configure_full_takeoff_run_budget($1,$2,$3,$4,$5,$6,$7)',
  [run.id,lease,'openai',['gpt-6-astra'],amount,2,'offline-fixture-approval']);}
async function reserve(db,run,event){
  await db.query('insert into api_usage_events values($1,$2,$3,$4,$5,$6,$7)',[event,ids.workspace,ids.project,ids.user,'openai','gpt-6-astra',`rb1:${run.id}:generate:pending`]);
  return db.query('select reserve_provider_spend($1,$2,$3,$4,$5,$6)',[event,run.id,ids.workspace,ids.user,'openai','gpt-6-astra']);
}

test('regional SQL fences partial checkpoints and refuses uncertain replay, malformed bounds and a replaced lease',async()=>{
  const {db,run,lease}=await fixture();try{
    await beginParent(db,run,lease);assert.equal((await beginRegion(db,run,lease)).disposition,'run');
    await assert.rejects(beginRegion(db,run,lease),/Uncertain regional/);
    const result={status:'succeeded',checkpoint:{physical_page_number:1,pass_type:'discipline',observations:[],blockers:[]},provider:'openai',model:'gpt-6-astra'};
    await db.query('select save_full_takeoff_region($1,$2,1,$3,$4,$5,$6,$7,$8)',[run.id,lease,'b'.repeat(64),'discipline','r1c1g2',JSON.stringify(region),'d'.repeat(64),JSON.stringify(result)]);
    assert.deepEqual((await beginRegion(db,run,lease)).result,result);
    await assert.rejects(beginRegion(db,run,lease,{...region,width:201}),/rectangle/);
    await assert.rejects(beginRegion(db,run,lease,{...region,x:null}),/identity/);
    await assert.rejects(beginRegion(db,run,'ffffffff-ffff-4fff-8fff-ffffffffffff'),/lease/);
    const grants=(await db.query("select has_function_privilege('authenticated','begin_full_takeoff_region(uuid,uuid,integer,text,text,text,jsonb,text)','EXECUTE') as allowed")).rows[0];
    assert.equal(grants.allowed,false);
  }finally{await db.close();}
});

test('reported credit creates no run budget; explicit approval is immutable and unknown usage conserves its full exposure',async()=>{
  const {db,run,lease}=await fixture();try{
    await assert.rejects(reserve(db,run,'50000000-0000-4000-8000-000000000001'),/not approved/);
    await configure(db,run,lease);await configure(db,run,lease);
    await assert.rejects(configure(db,run,lease,99),/silently replaced/);
    await reserve(db,run,'50000000-0000-4000-8000-000000000002');
    await db.exec("update provider_spend_reservations set status='captured',telemetry_known=false,estimated_cost_usd=null");
    await reserve(db,run,'50000000-0000-4000-8000-000000000003');
    await assert.rejects(reserve(db,run,'50000000-0000-4000-8000-000000000004'),/run spend limit/);
    assert.equal((await db.query('select sum(reserved_usd)::float8 as exposure from provider_spend_reservations')).rows[0].exposure,5);
    assert.equal((await db.query("select has_function_privilege('service_role','reserve_provider_spend_before_full_run_budget(uuid,uuid,uuid,uuid,text,text)','EXECUTE') as allowed")).rows[0].allowed,false);
  }finally{await db.close();}
});

test('wrong model or withdrawn owner/workspace authority never reserves provider spending',async()=>{
  const {db,run,lease}=await fixture();try{
    await configure(db,run,lease);
    await db.exec('update profiles set is_platform_admin=false');
    await assert.rejects(reserve(db,run,'50000000-0000-4000-8000-000000000005'),/access denied/);
    assert.equal((await db.query('select count(*)::int as count from provider_spend_reservations')).rows[0].count,0);
  }finally{await db.close();}
});
