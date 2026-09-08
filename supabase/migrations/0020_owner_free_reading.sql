-- Owner-only free plan reading.
--
-- Customers are unaffected: reserve_project_reading and its confirmed-payment
-- requirement are untouched. This adds a SEPARATE reservation for an explicitly
-- allowlisted workspace, whose caller must be that workspace's own creator.
--
-- No fake payment is created: plan_reading_jobs carries no quote linkage, and
-- project_reading_quotes.amount_cents has `check (amount_cents > 0)`, so a
-- zero-amount quote is impossible by construction. The free path therefore
-- never writes a quote row at all.

create table if not exists private.free_owner_workspaces (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  note text,
  created_at timestamptz not null default now()
);
alter table private.free_owner_workspaces enable row level security;
revoke all on private.free_owner_workspaces from public, anon, authenticated;
-- Closed by default: no row is inserted here by this migration. An operator
-- must explicitly allowlist the owner workspace.


-- Completion for the free path. Mirrors finish_project_reading's guarantees --
-- real findings only, no synthetic summaries, needs_review on success -- but
-- authorizes on the allowlisted owner workspace instead of a paid quote.
create function public.finish_owner_free_reading(
  p_job_id uuid, p_user_id uuid, p_summary jsonb, p_findings jsonb, p_error text)
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare j public.plan_reading_jobs; begin
  select * into j from public.plan_reading_jobs where id = p_job_id for update;
  if not found then raise exception 'Reading is not authorized'; end if;
  if j.status <> 'processing' then raise exception 'Reading is not authorized'; end if;
  -- The job must belong to an allowlisted owner workspace and to this caller.
  if not exists (select 1 from private.free_owner_workspaces where workspace_id = j.workspace_id)
     or j.requested_by <> p_user_id then
    raise exception 'Reading is not authorized';
  end if;

  if p_error is not null then
    update public.plan_reading_jobs set status='failed', processing_error=left(p_error,1000), completed_at=now()
      where id=p_job_id returning * into j;
    return to_jsonb(j);
  end if;

  -- Identical honesty bar to the paid path: no synthetic or empty results.
  -- SQL NULL is rejected explicitly first: `jsonb_typeof(NULL) <> 'array'` is
  -- NULL, not true, so three-valued logic would let a NULL payload fall
  -- through this guard and mark the job needs_review with zero findings.
  if p_findings is null or jsonb_typeof(p_findings) is distinct from 'array'
    or jsonb_array_length(p_findings) is null
    or jsonb_array_length(p_findings) not between 1 and 200
    or coalesce((p_summary->>'synthetic')::boolean,false) then
    raise exception 'Real findings required';
  end if;

  insert into public.plan_reading_findings(job_id,workspace_id,project_id,file_id,page_number,finding_type,label,value_text,quantity,unit,confidence,geometry,source_excerpt)
    select p_job_id,j.workspace_id,j.project_id,j.file_id,f.page_number,f.finding_type,f.label,f.value_text,f.quantity,f.unit,f.confidence,coalesce(f.geometry,'{}'),f.source_excerpt
    from jsonb_to_recordset(p_findings) as f(page_number integer,finding_type text,label text,value_text text,quantity numeric,unit text,confidence numeric,geometry jsonb,source_excerpt text);
  update public.plan_reading_jobs set status='needs_review', output_summary=p_summary, completed_at=now(), processing_error=null
    where id=p_job_id returning * into j;
  return to_jsonb(j) || jsonb_build_object('plan_reading_findings',(select jsonb_agg(to_jsonb(f)) from public.plan_reading_findings f where job_id=p_job_id));
end $$;

revoke all on function public.finish_owner_free_reading(uuid, uuid, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.finish_owner_free_reading(uuid, uuid, jsonb, jsonb, text) to service_role;

-- Mark the job processing at reservation time so the completion guard above is
-- meaningful (the paid path does this through the quote's status machine).
create or replace function public.reserve_owner_free_reading(
  p_user_id uuid, p_workspace_id uuid, p_project_id uuid, p_file_id uuid, p_model text,
  p_file_sha256 text, p_request_fingerprint text)
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare j public.plan_reading_jobs; begin
  if p_file_sha256 !~ '^[a-f0-9]{64}$' or p_request_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid plan reading request identity'; end if;
  perform 1 from public.workspaces where id = p_workspace_id for update;
  if not exists (select 1 from private.free_owner_workspaces where workspace_id = p_workspace_id) then
    raise exception 'Free reading is not enabled for this workspace'; end if;
  if not exists (select 1 from public.workspaces where id = p_workspace_id and created_by = p_user_id) then
    raise exception 'Free reading is restricted to the workspace owner'; end if;
  if not exists (select 1 from public.workspaces where id = p_workspace_id and ai_processing_consented_at is not null) then
    raise exception 'AI processing consent required'; end if;
  if not exists (select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = p_user_id and role in ('admin','estimator')) then
    raise exception 'Workspace access denied'; end if;
  if not exists (select 1 from public.project_files
    where id = p_file_id and workspace_id = p_workspace_id and project_id = p_project_id
      and processing_status not in ('uploading','failed')) then raise exception 'File unavailable'; end if;

  -- Idempotent re-use, keyed on the FULL request identity: the server-verified
  -- file digest plus the normalized trades/scope/model/mode fingerprint. Re-using
  -- on workspace+project+file alone would silently return a previous result for a
  -- different scope or model, so only an identical authorized analysis re-uses.
  -- The workspace row is locked above, so this lookup and the insert below are
  -- atomic against a concurrent duplicate.
  select * into j from public.plan_reading_jobs
    where workspace_id = p_workspace_id and project_id = p_project_id and file_id = p_file_id
      and (input_summary->>'entitlement') = 'owner_free'
      and (input_summary->>'file_sha256') = p_file_sha256
      and (input_summary->>'request_fingerprint') = p_request_fingerprint
      and status in ('processing','needs_review','ready')
    order by created_at desc limit 1;
  if found then return jsonb_build_object('reused', true, 'job', to_jsonb(j)); end if;

  -- Daily cap, counted under the same lock rather than by a standalone COUNT, so
  -- two concurrent callers cannot both pass it. Failed jobs ARE counted: a failed
  -- provider call still consumed a free-tier request, so excluding them would let
  -- repeated failures retry without limit and silently exhaust the real quota.
  -- Rejected BEFORE any provider call, so an exhausted quota never reaches Gemini.
  if (select count(*) from public.plan_reading_jobs
      where workspace_id = p_workspace_id and (input_summary->>'entitlement') = 'owner_free'
        and created_at >= now() - interval '24 hours')
      >= coalesce(nullif(current_setting('roughbid.free_daily_cap', true),'')::int, 20) then
    raise exception 'Free daily reading limit reached for this workspace';
  end if;

  insert into public.plan_reading_jobs (workspace_id, project_id, file_id, requested_by, model, status, input_summary)
  values (p_workspace_id, p_project_id, p_file_id, p_user_id, p_model, 'processing',
          jsonb_build_object('entitlement','owner_free','billed',false,
                             'file_sha256',p_file_sha256,'request_fingerprint',p_request_fingerprint))
  returning * into j;
  return jsonb_build_object('reused', false, 'job', to_jsonb(j));
end $$;

-- CREATE OR REPLACE re-applies PostgreSQL's default EXECUTE grant to PUBLIC, so
-- the revoke must follow the final definition, not only the first one.
revoke all on function public.reserve_owner_free_reading(uuid, uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.reserve_owner_free_reading(uuid, uuid, uuid, uuid, text, text, text) to service_role;
revoke all on function public.finish_owner_free_reading(uuid, uuid, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.finish_owner_free_reading(uuid, uuid, jsonb, jsonb, text) to service_role;
