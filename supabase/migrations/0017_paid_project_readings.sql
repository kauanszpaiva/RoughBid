-- Authoritative, version-bound payment gate. Existing trial/access grants never authorize AI.
-- Accounts can keep organizing their own company projects after the former trial expires.
-- Workspace/role RLS still applies; only reserve_project_reading authorizes AI spending.
create or replace function private.has_product_access()
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$ select auth.uid() is not null $$;

create table public.project_reading_quotes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  project_id uuid not null references public.projects(id),
  file_id uuid not null references public.project_files(id),
  user_id uuid not null references auth.users(id),
  file_sha256 text not null check (file_sha256 ~ '^[a-f0-9]{64}$'),
  page_count integer not null check (page_count between 1 and 100),
  trades jsonb not null check (jsonb_typeof(trades) = 'array' and jsonb_array_length(trades) between 1 and 7),
  scope text not null check (char_length(scope) <= 500),
  amount_cents integer not null check (amount_cents > 0),
  cost_cents integer not null check (cost_cents > 0),
  currency text not null default 'usd' check (currency = 'usd'),
  pricing_version text not null,
  membership text not null check (membership in ('standard','starter','pro','team','enterprise')),
  livemode boolean not null,
  status text not null default 'quoted' check (status in ('quoted','paid','processing','complete','failed','revoked')),
  stripe_session_id text unique,
  payment_intent_id text unique,
  attempts integer not null default 0 check (attempts between 0 and 2),
  job_id uuid unique references public.plan_reading_jobs(id),
  paid_at timestamptz,
  expires_at timestamptz not null default now() + interval '1 hour',
  created_at timestamptz not null default now(),
  foreign key (project_id, workspace_id) references public.projects(id, workspace_id)
);
create index project_reading_quotes_project_idx on public.project_reading_quotes(workspace_id, project_id, created_at desc);
create table public.project_payment_events (
  event_id text primary key,
  quote_id uuid not null references public.project_reading_quotes(id),
  created_at timestamptz not null default now()
);
alter table public.project_reading_quotes enable row level security;
alter table public.project_payment_events enable row level security;
revoke all on public.project_reading_quotes, public.project_payment_events from anon, authenticated;
-- Cost/margin policy is server-only; customers see a curated response from the API.
grant all on public.project_reading_quotes, public.project_payment_events to service_role;
revoke insert, update, delete on public.plan_reading_jobs from authenticated, anon;

create function public.confirm_project_reading_payment(p_event_id text, p_quote_id uuid, p_session_id text,
  p_payment_intent text, p_amount integer, p_currency text, p_livemode boolean)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare q public.project_reading_quotes; begin
  select * into q from public.project_reading_quotes where id = p_quote_id for update;
  if not found then raise exception 'Quote not found'; end if;
  if q.amount_cents <> p_amount or q.currency <> p_currency or q.livemode <> p_livemode
    or p_session_id is null or p_payment_intent is null then raise exception 'Payment does not match quote'; end if;
  if q.stripe_session_id is not null and q.stripe_session_id <> p_session_id then raise exception 'Payment session mismatch'; end if;
  insert into public.project_payment_events(event_id, quote_id) values (p_event_id, q.id) on conflict do nothing;
  if not found then return false; end if;
  update public.project_reading_quotes set
    status = case when status = 'quoted' then 'paid' else status end,
    stripe_session_id = p_session_id, payment_intent_id = p_payment_intent, paid_at = coalesce(paid_at, now())
    where id = q.id;
  return true;
end $$;

create function public.reserve_project_reading(p_quote_id uuid, p_user_id uuid, p_workspace_id uuid,
  p_project_id uuid, p_file_id uuid, p_model text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare q public.project_reading_quotes; j public.plan_reading_jobs; begin
  -- Workspace row serializes the daily cap across projects, not only one quote.
  perform 1 from public.workspaces where id = p_workspace_id for update;
  if not exists (select 1 from public.workspace_members where workspace_id = p_workspace_id and user_id = p_user_id and role in ('admin','estimator')) then
    raise exception 'Workspace access denied'; end if;
  if not exists (select 1 from public.workspaces where id = p_workspace_id and ai_processing_consented_at is not null) then
    raise exception 'AI processing consent required'; end if;
  select * into q from public.project_reading_quotes where id = p_quote_id and workspace_id = p_workspace_id
    and project_id = p_project_id and file_id = p_file_id for update;
  if not found then raise exception 'Paid quote required'; end if;
  if not exists (select 1 from public.project_files where id = p_file_id and workspace_id = p_workspace_id
    and project_id = p_project_id and processing_status not in ('uploading','failed')) then raise exception 'File unavailable'; end if;
  if q.status = 'complete' then
    select * into j from public.plan_reading_jobs where id = q.job_id;
    return jsonb_build_object('reused', true, 'job', to_jsonb(j), 'quote', to_jsonb(q));
  end if;
  if q.status = 'processing' then raise exception 'This reading is already processing'; end if;
  if q.status not in ('paid','failed') or q.paid_at is null then raise exception 'Paid quote required'; end if;
  if q.attempts >= 2 then raise exception 'Attempt limit reached. Contact support for review or refund'; end if;
  if (select count(*) from public.plan_reading_jobs where workspace_id = p_workspace_id and created_at > now() - interval '24 hours') >= 25 then
    raise exception 'Daily reading limit reached'; end if;
  if q.job_id is null then
    insert into public.plan_reading_jobs(workspace_id, project_id, file_id, requested_by, status, mode, model, started_at, input_summary)
      values(p_workspace_id, p_project_id, p_file_id, p_user_id, 'processing', 'quick', p_model, now(),
      jsonb_build_object('quote_id',q.id,'requested_trades',q.trades,'requested_scope',q.scope,'human_review_required',true)) returning * into j;
  else
    update public.plan_reading_jobs set status='processing', processing_error=null, started_at=now(), completed_at=null
      where id=q.job_id returning * into j;
  end if;
  update public.project_reading_quotes set status='processing', attempts=attempts+1, job_id=j.id where id=q.id returning * into q;
  return jsonb_build_object('reused',false,'job',to_jsonb(j),'quote',to_jsonb(q));
end $$;

create function public.finish_project_reading(p_quote_id uuid, p_job_id uuid, p_summary jsonb, p_findings jsonb, p_error text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare q public.project_reading_quotes; j public.plan_reading_jobs; begin
  select * into q from public.project_reading_quotes where id=p_quote_id and job_id=p_job_id for update;
  if not found or q.status <> 'processing' or q.paid_at is null then raise exception 'Reading is not authorized'; end if;
  if p_error is not null then
    update public.plan_reading_jobs set status='failed',processing_error=left(p_error,1000),completed_at=now() where id=p_job_id returning * into j;
    update public.project_reading_quotes set status='failed' where id=q.id;
    return to_jsonb(j);
  end if;
  if coalesce((p_summary->>'synthetic')::boolean,false) or jsonb_typeof(p_findings) <> 'array'
    or jsonb_array_length(p_findings) not between 1 and 200 then raise exception 'Real findings required'; end if;
  insert into public.plan_reading_findings(job_id,workspace_id,project_id,file_id,page_number,finding_type,label,value_text,quantity,unit,confidence,geometry,source_excerpt)
    select p_job_id,q.workspace_id,q.project_id,q.file_id,f.page_number,f.finding_type,f.label,f.value_text,f.quantity,f.unit,f.confidence,coalesce(f.geometry,'{}'),f.source_excerpt
    from jsonb_to_recordset(p_findings) as f(page_number integer,finding_type text,label text,value_text text,quantity numeric,unit text,confidence numeric,geometry jsonb,source_excerpt text);
  update public.plan_reading_jobs set status='needs_review',output_summary=p_summary,completed_at=now(),processing_error=null
    where id=p_job_id returning * into j;
  update public.project_reading_quotes set status='complete' where id=q.id;
  return to_jsonb(j) || jsonb_build_object('plan_reading_findings',(select jsonb_agg(to_jsonb(f)) from public.plan_reading_findings f where job_id=p_job_id));
end $$;

revoke all on function public.confirm_project_reading_payment(text,uuid,text,text,integer,text,boolean) from public,anon,authenticated;
revoke all on function public.reserve_project_reading(uuid,uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.finish_project_reading(uuid,uuid,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.confirm_project_reading_payment(text,uuid,text,text,integer,text,boolean) to service_role;
grant execute on function public.reserve_project_reading(uuid,uuid,uuid,uuid,uuid,text) to service_role;
grant execute on function public.finish_project_reading(uuid,uuid,jsonb,jsonb,text) to service_role;

create function public.revoke_project_reading_payment(p_event_id text, p_quote_id uuid, p_payment_intent text, p_livemode boolean)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare q public.project_reading_quotes; begin
  select * into q from public.project_reading_quotes where id=p_quote_id for update;
  if not found or q.livemode <> p_livemode or (q.payment_intent_id is not null and q.payment_intent_id <> p_payment_intent) then
    raise exception 'Payment does not match quote'; end if;
  insert into public.project_payment_events(event_id,quote_id) values(p_event_id,q.id) on conflict do nothing;
  if not found then return false; end if;
  update public.project_reading_quotes set status='revoked',payment_intent_id=p_payment_intent where id=q.id;
  update public.plan_reading_jobs set status='failed',processing_error='Payment was refunded or disputed',completed_at=now()
    where id=q.job_id and status='processing';
  return true;
end $$;
revoke all on function public.revoke_project_reading_payment(text,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.revoke_project_reading_payment(text,uuid,text,boolean) to service_role;

-- Serialize quote creation so simultaneous browser requests share one checkout.
create function public.create_project_reading_quote(p_input jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare q public.project_reading_quotes; v public.project_reading_quotes; begin
  v := jsonb_populate_record(null::public.project_reading_quotes,p_input);
  perform 1 from public.workspaces where id=v.workspace_id for update;
  if not exists(select 1 from public.workspace_members where workspace_id=v.workspace_id and user_id=v.user_id and role in ('admin','estimator')) then raise exception 'Workspace access denied'; end if;
  if not exists(select 1 from public.project_files where id=v.file_id and workspace_id=v.workspace_id and project_id=v.project_id) then raise exception 'File unavailable'; end if;
  select * into q from public.project_reading_quotes where workspace_id=v.workspace_id and project_id=v.project_id
    and file_id=v.file_id and file_sha256=v.file_sha256 and scope=v.scope and trades=v.trades and livemode=v.livemode
    and status <> 'revoked' and (paid_at is not null or (expires_at > now() and stripe_session_id is not null)
      or (expires_at > now()+interval '31 minutes' and amount_cents=v.amount_cents and membership=v.membership and pricing_version=v.pricing_version))
    order by created_at desc limit 1;
  if found then return to_jsonb(q); end if;
  insert into public.project_reading_quotes(workspace_id,project_id,file_id,user_id,file_sha256,page_count,trades,scope,amount_cents,cost_cents,pricing_version,membership,livemode)
    values(v.workspace_id,v.project_id,v.file_id,v.user_id,v.file_sha256,v.page_count,v.trades,v.scope,v.amount_cents,v.cost_cents,v.pricing_version,v.membership,v.livemode) returning * into q;
  return to_jsonb(q);
end $$;
revoke all on function public.create_project_reading_quote(jsonb) from public,anon,authenticated;
grant execute on function public.create_project_reading_quote(jsonb) to service_role;

-- Historical simulated findings cannot become new estimate items.
create or replace function public.set_plan_reading_finding_status(finding_id uuid, new_status text)
returns setof public.plan_reading_findings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_workspace uuid;
begin
  if exists (select 1 from public.plan_reading_findings f join public.plan_reading_jobs j on j.id=f.job_id where f.id=finding_id and j.output_summary->>'synthetic'='true') then
    raise exception 'Simulated findings cannot be accepted. Request a real plan reading';
  end if;
  if new_status not in ('needs_review', 'accepted', 'rejected') then
    raise exception 'new_status must be needs_review, accepted, or rejected';
  end if;

  select workspace_id into target_workspace
  from public.plan_reading_findings
  where id = finding_id;

  if target_workspace is null then
    raise exception 'Finding not found';
  end if;
  if not private.has_workspace_role(target_workspace, array['admin', 'estimator']) then
    raise exception 'Insufficient workspace role to review plan reading findings';
  end if;
  if not private.has_product_access() then
    raise exception 'An active RoughBid entitlement is required';
  end if;

  return query
    update public.plan_reading_findings
    set status = new_status
    where id = finding_id
    returning *;
end;
$$;

revoke all on function public.set_plan_reading_finding_status(uuid, text) from public, anon;
grant execute on function public.set_plan_reading_finding_status(uuid, text) to authenticated;
