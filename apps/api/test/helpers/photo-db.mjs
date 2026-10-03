import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

export const USER='00000000-0000-4000-8000-000000000001';
export const WORKSPACE='10000000-0000-4000-8000-000000000001';
export const PROJECT='20000000-0000-4000-8000-000000000001';
export const PHOTO='30000000-0000-4000-8000-000000000001';
export const REQUEST_KEY='40000000-0000-4000-8000-000000000001';
export const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64');
const migration=name=>readFileSync(new URL(`../../../../supabase/migrations/${name}`,import.meta.url),'utf8');
const identifier=value=>{if(!/^[a-z_][a-z0-9_]*$/i.test(value))throw Error('invalid test SQL identifier');return value;};
const bind=value=>value!==null&&typeof value==='object'?JSON.stringify(value):value;

/** Real embedded PostgreSQL migrations; only auth, object storage and vendor transport are mocked. */
export async function photoDatabase(){
  const sql=new PGlite();
  try {
  await sql.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema private;
    create table auth.users(id uuid primary key);
    create table profiles(id uuid primary key,is_platform_admin boolean);
    create table workspaces(id uuid primary key,ai_processing_consented_at timestamptz);
    create table workspace_members(workspace_id uuid,user_id uuid,role text);
    create table projects(id uuid primary key,workspace_id uuid,unique(id,workspace_id));
    create table project_files(id uuid primary key,workspace_id uuid,project_id uuid,storage_path text,processing_status text,page_count integer,unique(id,workspace_id,project_id));
    create function auth.uid() returns uuid language sql stable as 'select ''${USER}''::uuid';
    create function private.has_workspace_role(uuid,text[]) returns boolean language sql stable as 'select true';
    create function private.has_product_access() returns boolean language sql stable as 'select true';
    create table plan_reading_jobs(id uuid primary key,workspace_id uuid,project_id uuid,requested_by uuid,created_at timestamptz default now());
    create table api_usage_events(id uuid primary key,workspace_id uuid,project_id uuid,user_id uuid,provider text,model text,operation text,
      input_tokens bigint,output_tokens bigint,estimated_cost_usd numeric,actual_cost_usd numeric,sensitive_payload boolean,provider_request_id text);
    create table provider_spend_policy(singleton boolean primary key,enabled boolean,rolling_window interval,spend_cap_usd numeric,call_reservation_usd numeric);
    insert into provider_spend_policy values(true,true,interval '24 hours',25,2.5);
    create table provider_spend_reservations(event_id uuid primary key references api_usage_events(id),job_id uuid not null references plan_reading_jobs(id),
      workspace_id uuid references workspaces(id),user_id uuid,provider text,model text,status text default 'reserved',reserved_usd numeric,
      estimated_cost_usd numeric,telemetry_known boolean default false,created_at timestamptz default now(),settled_at timestamptz);
    insert into auth.users values('${USER}'); insert into profiles values('${USER}',true);
    insert into workspaces values('${WORKSPACE}',now()); insert into workspace_members values('${WORKSPACE}','${USER}','estimator');
    insert into projects values('${PROJECT}','${WORKSPACE}');
  `);
  await sql.exec(migration('20260910225937_takeoff_v2_foundation.sql'));
  await sql.exec(migration('20261002120000_full_takeoff_v2_durable.sql'));
  // Execute the actual existing capture routine, without unrelated marketplace tables.
  const capture=migration('0039_commercial_spend_and_marketplace.sql').match(/create function public\.capture_provider_spend[\s\S]*?end \$\$;/i)?.[0];
  if(!capture)throw Error('capture routine not found');
  await sql.exec(capture);
  await sql.exec(migration('20261002130000_photo_takeoff.sql'));
  } catch(error) {await sql.close();throw new Error(`Photo fixture migration: ${error.message} (${error.code}, position ${error.position})`);}
  let authenticatedUser=USER;
  const client={
    auth:{async getUser(){return {data:{user:authenticatedUser?{id:authenticatedUser}:null},error:null};}},storage:{from(){throw Error('unexpected Supabase storage call');}},
    async rpc(name,args){
      try{
        identifier(name);const keys=Object.keys(args),values=keys.map(key=>bind(args[key]));
        const query=`select public.${name}(${keys.map((key,index)=>`${identifier(key)}=>$${index+1}`).join(',')}) as result`;
        const result=await sql.query(query,values);return {data:result.rows[0].result,error:null};
      }catch(error){return {data:null,error:{message:error.message}};}
    },
    from(table){
      identifier(table);let columns='*',operation='select',row,filters=[],ordering,maximum,single=false,execution;
      const query={
        select(value='*'){columns=value;return query;},insert(value){operation='insert';row=value;return query;},update(value){operation='update';row=value;return query;},
        eq(field,value){filters.push([identifier(field),'eq',value]);return query;},in(field,values){filters.push([identifier(field),'in',values]);return query;},
        order(field,options={}){ordering=`${identifier(field)} ${options.ascending===false?'desc':'asc'}`;return query;},limit(value){maximum=value;return query;},
        single(){single=true;return query;},maybeSingle(){single=true;return query;},
        then(resolve,reject){
          execution??=(async()=>{
            try{
              const projection=columns==='*'?'*':columns.split(',').map(identifier).join(',');
              const values=[],param=value=>{values.push(bind(value));return `$${values.length}`;};
              let statement;
              if(operation==='insert'){
                const fields=Object.keys(row).map(identifier);statement=`insert into ${table}(${fields.join(',')}) values(${fields.map(field=>param(row[field])).join(',')})`;
              }else if(operation==='update')statement=`update ${table} set ${Object.keys(row).map(field=>`${identifier(field)}=${param(row[field])}`).join(',')}`;
              else statement=`select ${projection} from ${table}`;
              if(filters.length)statement+=' where '+filters.map(([field,kind,value])=>kind==='in'?`${field} in (${value.map(param).join(',')})`:`${field}=${param(value)}`).join(' and ');
              if(operation==='select'){
                if(ordering)statement+=' order by '+ordering;
                if(maximum)statement+=' limit '+Number(maximum);
              }else statement+=' returning '+projection;
              const result=await sql.query(statement,values);
              return {data:single?(result.rows[0]??null):result.rows,error:null};
            }catch(error){return {data:null,error:{message:error.message}};}
          })();return execution.then(resolve,reject);
        },
      };return query;
    },
  };
  return {sql,client,setAuthenticatedUser(user){authenticatedUser=user;},close:()=>sql.close()};
}
