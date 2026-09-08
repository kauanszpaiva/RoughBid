-- Closed invitation cohort. All dollar amounts are conservative cents reserved
-- BEFORE a provider call, never estimates refunded after an ambiguous failure.
create table public.pilot_cohorts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  capacity integer not null default 25 check (capacity between 1 and 25),
  budget_cents integer not null default 12500 check (budget_cents between 0 and 12500),
  reserved_cents integer not null default 0 check (reserved_cents between 0 and budget_cents),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.pilot_cohorts(code) values ('founding-pilot-60d');

create table public.pilot_invitations (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid not null references public.pilot_cohorts(id) on delete restrict,
  email text not null check (email = lower(btrim(email)) and char_length(email) between 3 and 254),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  preset text not null default 'pilot60' check (preset in ('sample1','month1','pilot60')),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete restrict,
  revoked_at timestamptz,
  email_status text not null default 'pending' check (email_status in ('pending','sent','failed')),
  email_message_id text,
  email_error text,
  email_attempts integer not null default 0 check (email_attempts >= 0),
  email_sent_at timestamptz,
  unique(cohort_id,email),
  check (expires_at > created_at),
  check ((accepted_at is null) = (accepted_by is null))
);

create table public.pilot_enrollments (
  user_id uuid primary key references auth.users(id) on delete restrict,
  cohort_id uuid not null references public.pilot_cohorts(id) on delete restrict,
  invitation_id uuid not null unique references public.pilot_invitations(id) on delete restrict,
  workspace_id uuid not null unique references public.workspaces(id) on delete restrict,
  preset text not null check (preset in ('sample1','month1','pilot60')),
  starts_at timestamptz not null,
  expires_at timestamptz not null,
  reserved_cents integer not null default 0 check (reserved_cents between 0 and 500),
  revoked_at timestamptz,
  check (expires_at = starts_at + case preset when 'sample1' then interval '7 days' when 'month1' then interval '30 days' else interval '60 days' end)
);

-- No project/file FK: deleting or archiving customer data NEVER resets allowance.
create table public.pilot_project_creations (
  project_id uuid primary key,
  user_id uuid not null references public.pilot_enrollments(user_id) on delete restrict,
  workspace_id uuid not null,
  created_at timestamptz not null default now()
);
create index pilot_project_user_time_idx on public.pilot_project_creations(user_id,created_at);
create table public.pilot_file_creations (
  project_id uuid primary key,
  file_id uuid not null unique,
  user_id uuid not null references public.pilot_enrollments(user_id) on delete restrict,
  created_at timestamptz not null default now()
);
create table public.pilot_reading_reservations (
  project_id uuid primary key,
  user_id uuid not null references public.pilot_enrollments(user_id) on delete restrict,
  cohort_id uuid not null references public.pilot_cohorts(id) on delete restrict,
  job_id uuid not null unique,
  file_id uuid not null,
  request_fingerprint text not null,
  reserved_cents integer not null default 25 check (reserved_cents = 25),
  created_at timestamptz not null default now()
);

alter table public.pilot_cohorts enable row level security;
alter table public.pilot_invitations enable row level security;
alter table public.pilot_enrollments enable row level security;
alter table public.pilot_project_creations enable row level security;
alter table public.pilot_file_creations enable row level security;
alter table public.pilot_reading_reservations enable row level security;
revoke all on public.pilot_cohorts,public.pilot_invitations,public.pilot_enrollments,
  public.pilot_project_creations,public.pilot_file_creations,public.pilot_reading_reservations from public,anon,authenticated;
grant all on public.pilot_cohorts,public.pilot_invitations,public.pilot_enrollments,
  public.pilot_project_creations,public.pilot_file_creations,public.pilot_reading_reservations to service_role;

create function public.issue_pilot_invitation(p_admin_user_id uuid,p_email text,p_token_hash text,p_preset text default 'pilot60')
returns jsonb language plpgsql security definer set search_path = public,private,pg_temp as $$
declare c public.pilot_cohorts; i public.pilot_invitations;
begin
  if not exists(select 1 from public.profiles where id=p_admin_user_id and is_platform_admin) then raise exception 'Platform administrator access required'; end if;
  if p_email is null or lower(btrim(p_email)) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or char_length(p_email)>254 then raise exception 'Valid recipient email required'; end if;
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid invitation token'; end if;
  if p_preset is null or p_preset not in ('sample1','month1','pilot60') then raise exception 'Invalid pilot preset'; end if;
  select * into c from public.pilot_cohorts where code='founding-pilot-60d' for update;
  if not found or not c.enabled then raise exception 'Pilot enrollment is unavailable'; end if;
  select * into i from public.pilot_invitations where cohort_id=c.id and email=lower(btrim(p_email));
  -- Resending never rotates a token, changes the offer, or extends access.
  if found then
    if i.token_hash <> p_token_hash then raise exception 'Invitation token configuration changed; existing invitation preserved'; end if;
    return to_jsonb(i) - 'token_hash';
  end if;
  if (select count(*) from public.pilot_invitations where cohort_id=c.id and (accepted_at is not null or (revoked_at is null and expires_at>now()))) >= c.capacity then raise exception 'Pilot cohort is full (25 recipients maximum)'; end if;
  insert into public.pilot_invitations(cohort_id,email,token_hash,preset,created_by)
    values(c.id,lower(btrim(p_email)),p_token_hash,p_preset,p_admin_user_id) returning * into i;
  return to_jsonb(i) - 'token_hash';
end;
$$;

create function public.redeem_pilot_invitation(p_token_digest text,p_workspace_name text default 'My Workspace')
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare i public.pilot_invitations; e public.pilot_enrollments; c public.pilot_cohorts; recipient_email text; workspace uuid; started timestamptz;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_token_digest is null or p_token_digest !~ '^[a-f0-9]{64}$' then raise exception 'Invalid invitation token'; end if;
  if p_workspace_name is null or char_length(btrim(p_workspace_name)) not between 1 and 120 then raise exception 'Invalid workspace name'; end if;
  select * into i from public.pilot_invitations where token_hash=p_token_digest;
  if not found then raise exception 'Invitation is invalid, expired, or revoked'; end if;
  -- Consistent cohort-first locking serializes issuance, redemption and spend.
  select * into c from public.pilot_cohorts where id=i.cohort_id for update;
  select * into i from public.pilot_invitations where id=i.id for update;
  select lower(email) into recipient_email from auth.users where id=auth.uid() and email_confirmed_at is not null;
  if recipient_email is null or recipient_email <> i.email then raise exception 'Invitation requires its verified recipient email'; end if;
  if i.revoked_at is not null then raise exception 'Invitation is invalid, expired, or revoked'; end if;
  if i.accepted_at is not null then
    if i.accepted_by <> auth.uid() then raise exception 'Invitation already used'; end if;
    select * into e from public.pilot_enrollments where invitation_id=i.id;
    return jsonb_build_object('workspace_id',e.workspace_id,'starts_at',e.starts_at,'expires_at',e.expires_at,'preset',e.preset,'reused',true);
  end if;
  if not c.enabled or i.expires_at<=now() then raise exception 'Invitation is invalid, expired, or revoked'; end if;
  if exists(select 1 from public.pilot_enrollments where user_id=auth.uid()) then raise exception 'One pilot enrollment per user'; end if;
  if (select count(*) from public.pilot_enrollments where cohort_id=c.id)>=c.capacity then raise exception 'Pilot cohort is full'; end if;
  if exists(select 1 from public.profiles where id=auth.uid() and is_platform_admin) then raise exception 'Platform owner already has complimentary access'; end if;
  started := now();
  insert into public.workspaces(name,created_by) values(btrim(p_workspace_name),auth.uid()) returning id into workspace;
  insert into public.pilot_enrollments(user_id,cohort_id,invitation_id,workspace_id,preset,starts_at,expires_at)
    values(auth.uid(),c.id,i.id,workspace,i.preset,started,started+case i.preset when 'sample1' then interval '7 days' when 'month1' then interval '30 days' else interval '60 days' end) returning * into e;
  insert into public.entitlements(user_id,kind,source,external_ref,starts_at,expires_at)
    values(auth.uid(),'access_grant','limited_pilot',i.id::text,e.starts_at,e.expires_at);
  update public.pilot_invitations set accepted_at=started,accepted_by=auth.uid() where id=i.id;
  return jsonb_build_object('workspace_id',workspace,'starts_at',e.starts_at,'expires_at',e.expires_at,'preset',e.preset,'reused',false);
end;
$$;

create function public.get_pilot_access(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,private,pg_temp as $$
declare e public.pilot_enrollments; c public.pilot_cohorts; used integer; total integer; weekly integer; active boolean; state text;
begin
  select * into e from public.pilot_enrollments where user_id=p_user_id;
  if not found then return jsonb_build_object('enrolled',false,'active',false,'status','none'); end if;
  select * into c from public.pilot_cohorts where id=e.cohort_id;
  active := e.revoked_at is null and c.enabled and e.starts_at<=now() and e.expires_at>now();
  state := case when e.revoked_at is not null or not c.enabled then 'revoked' when e.expires_at<=now() then 'expired' else 'active' end;
  select count(*) into used from public.pilot_project_creations where user_id=p_user_id and created_at>now()-interval '7 days';
  select count(*) into total from public.pilot_project_creations where user_id=p_user_id;
  weekly := case when e.preset='pilot60' then 2 else 1 end;
  return jsonb_build_object('enrolled',true,'active',active,'status',state,'preset',e.preset,
    'workspace_id',e.workspace_id,'starts_at',e.starts_at,'expires_at',e.expires_at,
    'projects_used_7d',used,'projects_used_total',total,'projects_limit',weekly,
    'projects_remaining_this_week',case when not active then 0 when e.preset='sample1' then greatest(0,1-total) else greatest(0,weekly-used) end,
    'max_pdf_bytes',10485760,'max_pdf_pages',10,'max_files',1,'max_ai_attempts_per_project',1,
    'reserved_cents',e.reserved_cents,'budget_cents',500,'cohort_reserved_cents',c.reserved_cents,'cohort_budget_cents',c.budget_cents,
    'limits',jsonb_build_object('projects_per_week',weekly,'total_projects',case when e.preset='sample1' then 1 else null end,'max_pdf_bytes',10485760,'max_pages',10,'max_files',1,'ai_attempts_per_project',1));
end;
$$;
create function public.pilot_status() returns jsonb language sql stable security definer set search_path=public,pg_temp
as $$ select public.get_pilot_access(auth.uid()); $$;

create function public.list_pilot_invitations(p_admin_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  if not exists(select 1 from public.profiles where id=p_admin_user_id and is_platform_admin) then raise exception 'Platform administrator access required'; end if;
  return coalesce((select jsonb_agg((to_jsonb(i)-'token_hash') || jsonb_build_object(
    'access',a.state,'enrollment_expires_at',a.state->'expires_at','reserved_cents',coalesce((a.state->>'reserved_cents')::integer,0),
    'budget_cents',500,'projects_remaining_this_week',a.state->'projects_remaining_this_week') order by i.created_at desc)
    from public.pilot_invitations i left join lateral(select public.get_pilot_access(i.accepted_by) as state) a on i.accepted_by is not null),'[]'::jsonb);
end;
$$;
create function public.mark_pilot_invitation_delivery(p_admin_user_id uuid,p_invitation_id uuid,p_message_id text,p_error text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare i public.pilot_invitations;
begin
  if not exists(select 1 from public.profiles where id=p_admin_user_id and is_platform_admin) then raise exception 'Platform administrator access required'; end if;
  update public.pilot_invitations set email_status=case when p_error is null and nullif(p_message_id,'') is not null then 'sent' else 'failed' end,
    email_message_id=coalesce(nullif(p_message_id,''),email_message_id),email_error=left(p_error,500),email_attempts=email_attempts+1,
    email_sent_at=case when p_error is null and nullif(p_message_id,'') is not null then now() else email_sent_at end
    where id=p_invitation_id returning * into i;
  if not found then raise exception 'Invitation not found'; end if;
  return to_jsonb(i)-'token_hash';
end;
$$;
create function public.revoke_pilot_invitation(p_admin_user_id uuid,p_invitation_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare i public.pilot_invitations;
begin
  if not exists(select 1 from public.profiles where id=p_admin_user_id and is_platform_admin) then raise exception 'Platform administrator access required'; end if;
  update public.pilot_invitations set revoked_at=coalesce(revoked_at,now()) where id=p_invitation_id returning * into i;
  if not found then raise exception 'Invitation not found'; end if;
  update public.pilot_enrollments set revoked_at=coalesce(revoked_at,now()) where invitation_id=i.id;
  update public.entitlements set revoked_at=coalesce(revoked_at,now()) where source='limited_pilot' and external_ref=i.id::text;
  return to_jsonb(i)-'token_hash';
end;
$$;

create function private.enforce_pilot_project_limit() returns trigger language plpgsql security definer set search_path=public,private,pg_temp as $$
declare e public.pilot_enrollments; used integer;
begin
  if tg_op='UPDATE' then
    if (new.id<>old.id or new.created_by<>old.created_by or new.workspace_id<>old.workspace_id) and exists(select 1 from public.pilot_project_creations where project_id=old.id) then raise exception 'Pilot project identity is immutable'; end if;
    return new;
  end if;
  -- RLS already requires this; repeat it before trusting an administrator flag
  -- so future service wiring cannot spoof another creator to evade the quota.
  if auth.uid() is not null and auth.uid()<>new.created_by then raise exception 'Project creator must match the authenticated user'; end if;
  if exists(select 1 from public.profiles where id=new.created_by and is_platform_admin) then return new; end if;
  select * into e from public.pilot_enrollments where user_id=new.created_by for update;
  if not found or e.revoked_at is not null or e.expires_at<=now() then return new; end if;
  select count(*) into used from public.pilot_project_creations where user_id=e.user_id and (e.preset='sample1' or created_at>now()-interval '7 days');
  if used >= (case when e.preset='pilot60' then 2 else 1 end) then raise exception 'Pilot project limit reached'; end if;
  insert into public.pilot_project_creations(project_id,user_id,workspace_id) values(new.id,e.user_id,new.workspace_id);
  return new;
end;
$$;
create trigger enforce_pilot_project_limit before insert or update on public.projects for each row execute function private.enforce_pilot_project_limit();

create function private.enforce_pilot_file_limit() returns trigger language plpgsql security definer set search_path=public,private,pg_temp as $$
declare e public.pilot_enrollments; owner_id uuid; f public.pilot_file_creations;
begin
  if tg_op='UPDATE' then
    if (new.id<>old.id or new.project_id<>old.project_id or new.workspace_id<>old.workspace_id or new.uploaded_by<>old.uploaded_by or new.storage_path<>old.storage_path or new.byte_size<>old.byte_size) and exists(select 1 from public.pilot_file_creations where file_id=old.id) then raise exception 'Pilot file identity is immutable'; end if;
    return new;
  end if;
  select user_id into owner_id from public.pilot_project_creations where project_id=new.project_id;
  select * into e from public.pilot_enrollments where user_id=coalesce(owner_id,auth.uid(),new.uploaded_by) for update;
  if not found or e.revoked_at is not null or e.expires_at<=now() then return new; end if;
  if auth.uid() is not null and new.uploaded_by<>auth.uid() then raise exception 'Pilot file uploader must match the authenticated user'; end if;
  if new.byte_size is null or new.byte_size not between 1 and 10485760 then raise exception 'Pilot PDF must be at most 10 MiB'; end if;
  if exists(select 1 from public.pilot_file_creations where project_id=new.project_id) then raise exception 'Pilot allows one PDF per project including deleted files'; end if;
  insert into public.pilot_file_creations(project_id,file_id,user_id) values(new.project_id,new.id,e.user_id);
  return new;
end;
$$;
create trigger enforce_pilot_file_limit before insert or update on public.project_files for each row execute function private.enforce_pilot_file_limit();

create function private.enforce_pilot_seat_limit() returns trigger language plpgsql security definer set search_path=public,private,pg_temp as $$
declare e public.pilot_enrollments;
begin
  select * into e from public.pilot_enrollments where workspace_id=new.workspace_id for update;
  if found and e.revoked_at is null and e.expires_at>now() and new.user_id<>e.user_id then raise exception 'Pilot workspaces allow one login only'; end if;
  return new;
end;
$$;
create trigger enforce_pilot_seat_limit before insert or update on public.workspace_members for each row execute function private.enforce_pilot_seat_limit();

create function public.reserve_pilot_reading(p_user_id uuid,p_workspace_id uuid,p_project_id uuid,p_file_id uuid,p_model text,p_file_sha256 text,p_request_fingerprint text,p_requested_trades text[],p_scope text,p_page_count integer,p_byte_size bigint)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare e public.pilot_enrollments; c public.pilot_cohorts; r public.pilot_reading_reservations; j public.plan_reading_jobs;
begin
  if p_file_sha256 is null or p_file_sha256 !~ '^[a-f0-9]{64}$' or p_request_fingerprint is null or p_request_fingerprint !~ '^[a-f0-9]{64}$' then raise exception 'Invalid plan request identity'; end if;
  -- The server binds this single model to verified input/output limits and
  -- pricing. Model fallbacks must never create an unreserved provider charge.
  if p_model is distinct from 'gemini-2.5-flash' then raise exception 'Pilot model is not authorized'; end if;
  if p_page_count is null or p_page_count not between 1 and 10 or p_byte_size is null or p_byte_size not between 1 and 10485760 then raise exception 'Pilot PDF must have at most 10 pages and 10 MiB'; end if;
  if p_requested_trades is null or cardinality(p_requested_trades) not between 1 and 7 or char_length(coalesce(p_scope,''))>500 then raise exception 'Invalid reading scope'; end if;
  select * into e from public.pilot_enrollments where user_id=p_user_id;
  if not found then raise exception 'Active pilot enrollment required'; end if;
  select * into c from public.pilot_cohorts where id=e.cohort_id for update;
  select * into e from public.pilot_enrollments where user_id=p_user_id for update;
  if not c.enabled or e.revoked_at is not null or e.starts_at>now() or e.expires_at<=now() then raise exception 'Active pilot enrollment required'; end if;
  if e.workspace_id<>p_workspace_id or not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_user_id and role in ('admin','estimator')) then raise exception 'Pilot workspace access denied'; end if;
  if not exists(select 1 from public.workspaces where id=p_workspace_id and ai_processing_consented_at is not null) then raise exception 'AI processing consent required'; end if;
  if not exists(select 1 from public.projects where id=p_project_id and workspace_id=p_workspace_id and created_by=p_user_id) then raise exception 'Pilot project not found'; end if;
  if not exists(select 1 from public.pilot_project_creations where project_id=p_project_id and user_id=p_user_id) then raise exception 'Project was not created under this pilot'; end if;
  if not exists(select 1 from public.project_files where id=p_file_id and workspace_id=p_workspace_id and project_id=p_project_id and processing_status not in ('uploading','failed')) then raise exception 'File unavailable'; end if;
  if not exists(select 1 from public.pilot_file_creations where project_id=p_project_id and file_id=p_file_id and user_id=p_user_id) then raise exception 'File was not created under this pilot'; end if;
  select * into r from public.pilot_reading_reservations where project_id=p_project_id;
  if found then
    select * into j from public.plan_reading_jobs where id=r.job_id;
    if r.user_id=p_user_id and r.file_id=p_file_id and r.request_fingerprint=p_request_fingerprint and j.status in ('processing','needs_review','ready') then return jsonb_build_object('reused',true,'job',to_jsonb(j)); end if;
    raise exception 'Pilot allows one AI attempt per project; failed attempts remain counted';
  end if;
  if e.reserved_cents+25>500 or c.reserved_cents+25>c.budget_cents then raise exception 'Pilot API budget exhausted'; end if;
  insert into public.plan_reading_jobs(workspace_id,project_id,file_id,requested_by,status,mode,model,started_at,input_summary)
    values(p_workspace_id,p_project_id,p_file_id,p_user_id,'processing','quick',p_model,now(),jsonb_build_object('entitlement','limited_pilot','billed',false,'reserved_cents',25,'file_sha256',p_file_sha256,'request_fingerprint',p_request_fingerprint,'requested_trades',to_jsonb(p_requested_trades),'requested_scope',coalesce(p_scope,''),'page_count',p_page_count,'byte_size',p_byte_size,'human_review_required',true)) returning * into j;
  insert into public.pilot_reading_reservations(project_id,user_id,cohort_id,job_id,file_id,request_fingerprint) values(p_project_id,p_user_id,c.id,j.id,p_file_id,p_request_fingerprint);
  update public.pilot_enrollments set reserved_cents=reserved_cents+25 where user_id=p_user_id;
  update public.pilot_cohorts set reserved_cents=reserved_cents+25 where id=c.id;
  return jsonb_build_object('reused',false,'job',to_jsonb(j));
end;
$$;

create function public.finish_pilot_reading(p_job_id uuid,p_user_id uuid,p_summary jsonb,p_findings jsonb,p_error text)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare j public.plan_reading_jobs;
begin
  select * into j from public.plan_reading_jobs where id=p_job_id for update;
  if not found or j.status<>'processing' or j.requested_by<>p_user_id or j.input_summary->>'entitlement'<>'limited_pilot' then raise exception 'Reading is not authorized'; end if;
  if not exists(select 1 from public.pilot_reading_reservations where job_id=p_job_id and user_id=p_user_id) then raise exception 'Reading is not authorized'; end if;
  if p_error is not null then
    update public.plan_reading_jobs set status='failed',processing_error=left(p_error,1000),completed_at=now() where id=p_job_id returning * into j;
    return to_jsonb(j);
  end if;
  if p_findings is null or jsonb_typeof(p_findings) is distinct from 'array' or jsonb_array_length(p_findings) not between 1 and 200 or coalesce((p_summary->>'synthetic')::boolean,false) then raise exception 'Real findings required'; end if;
  if exists(select 1 from jsonb_array_elements(p_findings) f where (f->>'page_number')::integer not between 1 and (j.input_summary->>'page_count')::integer) then raise exception 'Finding page is outside this PDF'; end if;
  insert into public.plan_reading_findings(job_id,workspace_id,project_id,file_id,page_number,finding_type,label,value_text,quantity,unit,confidence,geometry,source_excerpt,status)
    select j.id,j.workspace_id,j.project_id,j.file_id,(f->>'page_number')::integer,f->>'finding_type',f->>'label',f->>'value_text',(f->>'quantity')::numeric,f->>'unit',(f->>'confidence')::numeric,coalesce(f->'geometry','{}'::jsonb),f->>'source_excerpt','needs_review' from jsonb_array_elements(p_findings) f;
  update public.plan_reading_jobs set status='needs_review',output_summary=p_summary,completed_at=now() where id=j.id returning * into j;
  return to_jsonb(j)||jsonb_build_object('plan_reading_findings',(select jsonb_agg(to_jsonb(f)) from public.plan_reading_findings f where job_id=j.id));
end;
$$;

revoke all on function public.issue_pilot_invitation(uuid,text,text,text),public.get_pilot_access(uuid),public.list_pilot_invitations(uuid),public.mark_pilot_invitation_delivery(uuid,uuid,text,text),public.revoke_pilot_invitation(uuid,uuid),public.reserve_pilot_reading(uuid,uuid,uuid,uuid,text,text,text,text[],text,integer,bigint),public.finish_pilot_reading(uuid,uuid,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.issue_pilot_invitation(uuid,text,text,text),public.get_pilot_access(uuid),public.list_pilot_invitations(uuid),public.mark_pilot_invitation_delivery(uuid,uuid,text,text),public.revoke_pilot_invitation(uuid,uuid),public.reserve_pilot_reading(uuid,uuid,uuid,uuid,text,text,text,text[],text,integer,bigint),public.finish_pilot_reading(uuid,uuid,jsonb,jsonb,text) to service_role;
revoke all on function public.redeem_pilot_invitation(text,text),public.pilot_status() from public,anon;
grant execute on function public.redeem_pilot_invitation(text,text),public.pilot_status() to authenticated;
revoke all on function private.enforce_pilot_project_limit(),private.enforce_pilot_file_limit(),private.enforce_pilot_seat_limit() from public,anon,authenticated;
