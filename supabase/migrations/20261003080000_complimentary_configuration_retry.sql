create or replace function public.reserve_full_takeoff_v2(p_user_id uuid,p_workspace_id uuid,p_project_id uuid,p_file_id uuid,p_manifest jsonb,p_version text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.takeoff_runs; sheet jsonb; pages integer; reused boolean:=false;
begin
  if p_version is distinct from 'takeoff-v2.2-durable' or jsonb_typeof(p_manifest) is distinct from 'object'
     or coalesce(p_manifest->>'fileSha256','')!~'^[a-f0-9]{64}$'
     or jsonb_typeof(p_manifest->'sheets') is distinct from 'array' then raise exception 'Invalid Full Takeoff manifest'; end if;
  if p_manifest ? 'paidAuthorization' then raise exception 'A complimentary run cannot carry paid authorization'; end if;
  pages:=(p_manifest->>'physicalPageCount')::integer;
  if pages is null or pages not between 1 and 200 or jsonb_array_length(p_manifest->'sheets')<>pages
     or (select count(distinct (s->>'physicalPageNumber')::integer) from jsonb_array_elements(p_manifest->'sheets') s)<>pages then raise exception 'Invalid Full Takeoff pages'; end if;
  for sheet in select value from jsonb_array_elements(p_manifest->'sheets') loop
    if coalesce((sheet->>'physicalPageNumber')::integer,0) not between 1 and pages or coalesce(sheet->>'pageSha256','')!~'^[a-f0-9]{64}$'
       or coalesce((sheet->>'widthPoints')::numeric,0)<=0 or coalesce((sheet->>'heightPoints')::numeric,0)<=0
       or coalesce((sheet->>'rotationDegrees')::integer,-1) not in (0,90,180,270)
       or coalesce(sheet->>'contentKind','') not in ('vector','raster','mixed','blank','unknown')
       or coalesce(sheet->>'textQuality','') not in ('good','partial','none','unreadable','unknown') then raise exception 'Invalid physical sheet'; end if;
  end loop;
  -- Serialize owner reservations and recheck all tenant and consent boundaries.
  perform 1 from public.profiles where id=p_user_id and is_platform_admin=true for update;
  if not found then raise exception 'Platform administrator access required'; end if;
  if not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_user_id and role in ('admin','estimator'))
     or not exists(select 1 from public.workspaces where id=p_workspace_id and ai_processing_consented_at is not null)
     or not exists(select 1 from public.projects where id=p_project_id and workspace_id=p_workspace_id)
     or not exists(select 1 from public.project_files where id=p_file_id and workspace_id=p_workspace_id and project_id=p_project_id and processing_status not in ('uploading','failed')
       and (page_count is null or page_count=0 or page_count=pages)) then raise exception 'Full Takeoff access denied'; end if;
  if not public.full_takeoff_v2_worker_available(p_version) then raise exception 'Full Takeoff worker unavailable'; end if;
  select * into r from public.takeoff_runs where workspace_id=p_workspace_id and project_id=p_project_id and file_id=p_file_id
    and file_sha256=p_manifest->>'fileSha256' and mode='full' and orchestrator_version=p_version and payment_kind='complimentary' for update;
  if found then
    reused:=true;
    if r.manifest<>p_manifest or (r.status='failed' and r.error_code='reading_configuration_unavailable') then
      -- Reauthorize only an untouched configuration failure. Evidence, funding,
      -- uncertain calls and all source identity remain immutable.
      if r.status<>'failed' or r.error_code is distinct from 'reading_configuration_unavailable'
         or r.requested_by is distinct from p_user_id
         or (r.manifest-'spendApproval') is distinct from (p_manifest-'spendApproval')
         or p_manifest->'spendApproval'->>'version' is distinct from 'full-user-spend-v1'
         or p_manifest->'spendApproval'->>'approvedBy' is distinct from p_user_id::text
         or r.worker_lease_id is not null or r.worker_lease_expires_at is not null
         or coalesce((r.progress->>'completed')::integer,0)<>0
         or exists(select 1 from public.takeoff_passes where takeoff_run_id=r.id)
         or exists(select 1 from public.takeoff_region_checkpoints where takeoff_run_id=r.id)
         or exists(select 1 from public.full_takeoff_provider_budgets where takeoff_run_id=r.id)
         or exists(select 1 from public.api_usage_events where operation like 'rb1:'||r.id::text||':%')
         then raise exception 'Saved Full Takeoff manifest differs or requires reconciliation'; end if;
      if not public.paid_full_daily_capacity_ready(p_user_id) then raise exception 'Daily Full Takeoff limit reached'; end if;
      update public.takeoff_runs set manifest=p_manifest,status='queued',processing_error=null,error_code=null,
        started_at=null,completed_at=null,worker_id=null,worker_heartbeat_at=null,not_before=null,waiting_reason=null,
        updated_at=now() where id=r.id returning * into r;
    end if;
  else
    if not public.paid_full_daily_capacity_ready(p_user_id) then raise exception 'Daily Full Takeoff limit reached'; end if;
    insert into public.takeoff_runs(workspace_id,project_id,file_id,mode,status,file_sha256,orchestrator_version,requested_by,manifest,progress)
      values(p_workspace_id,p_project_id,p_file_id,'full','queued',p_manifest->>'fileSha256',p_version,p_user_id,p_manifest,jsonb_build_object('completed',0,'total',pages*10)) returning * into r;
    for sheet in select value from jsonb_array_elements(p_manifest->'sheets') loop
      insert into public.plan_sheets(takeoff_run_id,workspace_id,project_id,file_id,physical_page_number,page_sha256,width_points,height_points,rotation_degrees,content_kind,text_quality,status,status_reason)
        values(r.id,p_workspace_id,p_project_id,p_file_id,(sheet->>'physicalPageNumber')::integer,sheet->>'pageSha256',(sheet->>'widthPoints')::numeric,(sheet->>'heightPoints')::numeric,
          (sheet->>'rotationDegrees')::integer,sheet->>'contentKind',sheet->>'textQuality','review_required','Deterministic preflight; source evidence and human review required.');
    end loop;
  end if;
  -- Return only reviewable lifecycle data, never worker leases or source content.
  return jsonb_build_object('reused',reused,'run',jsonb_build_object('id',r.id,'status',r.status,'progress',r.progress,'output_summary',r.output_summary));
end $$;


