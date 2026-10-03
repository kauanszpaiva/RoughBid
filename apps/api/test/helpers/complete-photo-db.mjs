import {readFileSync} from 'node:fs';
import {photoDatabase,USER} from './photo-db.mjs';
export async function completePhotoDatabase({reviewedExposure=false}={}){
 const fixture=await photoDatabase();
 try{
 await fixture.sql.exec(`alter table workspaces add column created_by uuid;update workspaces set created_by='${USER}';
 create table billing_customers(user_id uuid,stripe_price_id text,subscription_status text,current_period_end timestamptz,invoice_paid boolean);
 alter table plan_reading_jobs add column file_id uuid,add column status text,add column processing_error text,add column completed_at timestamptz,add column started_at timestamptz,add column mode text,add column model text,add column input_summary jsonb;
 create table plan_reading_findings(id uuid,job_id uuid,workspace_id uuid,status text);
 create table geometry_provider_spend_reservations(id uuid default gen_random_uuid(),reserved_usd numeric,estimated_cost_usd numeric,telemetry_known boolean default false,created_at timestamptz default now());`);
 for(const name of ['0017_paid_project_readings.sql','0023_durable_ai_plan_jobs.sql','20261002140000_takeoff_measurement_review.sql','20261002150000_full_takeoff_regions.sql','20261002160000_full_takeoff_run_budgets.sql','20261003010000_paid_full_takeoff.sql','20261003020000_full_takeoff_budget_wait.sql','20261003030000_full_reading_orders.sql','20261003050000_complete_photo_purchases.sql']){
 try{await fixture.sql.exec(readFileSync(new URL(`../../../../supabase/migrations/${name}`,import.meta.url),'utf8'));}catch(e){throw new Error(`${name}: ${e.message} position ${e.position}`);}}
 if(reviewedExposure)for(const name of ['20261003040000_provider_execution_bridge.sql','20261003060000_reviewed_operation_reservations.sql']){
 try{await fixture.sql.exec(readFileSync(new URL(`../../../../supabase/migrations/${name}`,import.meta.url),'utf8'));}catch(e){throw new Error(`${name}: ${e.message} position ${e.position}`);}}
 return fixture;
 }catch(e){await fixture.close();throw e;}
}
