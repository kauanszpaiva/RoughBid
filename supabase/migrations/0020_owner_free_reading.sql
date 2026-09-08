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
revoke all on private.free_owner_workspaces from anon, authenticated;
-- Closed by default: no row is inserted here by this migration. An operator
-- must explicitly allowlist the owner workspace.

create function public.reserve_owner_free_reading(
  p_user_id uuid, p_workspace_id uuid, p_project_id uuid, p_file_id uuid, p_model text)
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare j public.plan_reading_jobs; begin
  -- Serialize per workspace, matching the paid path's daily-cap behaviour.
  perform 1 from public.workspaces where id = p_workspace_id for update;

  -- 1. The workspace must be explicitly allowlisted. This is the entitlement.
  if not exists (select 1 from private.free_owner_workspaces where workspace_id = p_workspace_id) then
    raise exception 'Free reading is not enabled for this workspace';
  end if;

  -- 2. The caller must be the workspace's own creator, not merely an admin.
  if not exists (select 1 from public.workspaces
    where id = p_workspace_id and created_by = p_user_id) then
    raise exception 'Free reading is restricted to the workspace owner';
  end if;

  -- 3. Same consent and role requirements the paid path enforces.
  if not exists (select 1 from public.workspaces
    where id = p_workspace_id and ai_processing_consented_at is not null) then
    raise exception 'AI processing consent required';
  end if;
  if not exists (select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = p_user_id and role in ('admin','estimator')) then
    raise exception 'Workspace access denied';
  end if;

  -- 4. The file must belong to this tenant and have finished uploading.
  if not exists (select 1 from public.project_files
    where id = p_file_id and workspace_id = p_workspace_id and project_id = p_project_id
      and processing_status not in ('uploading','failed')) then
    raise exception 'File unavailable';
  end if;

  insert into public.plan_reading_jobs (workspace_id, project_id, file_id, requested_by, model, status, input_summary)
  values (p_workspace_id, p_project_id, p_file_id, p_user_id, p_model, 'queued',
          jsonb_build_object('entitlement', 'owner_free', 'billed', false))
  returning * into j;

  return jsonb_build_object('reused', false, 'job', to_jsonb(j));
end $$;

revoke all on function public.reserve_owner_free_reading(uuid, uuid, uuid, uuid, text) from anon, authenticated;
grant execute on function public.reserve_owner_free_reading(uuid, uuid, uuid, uuid, text) to service_role;
