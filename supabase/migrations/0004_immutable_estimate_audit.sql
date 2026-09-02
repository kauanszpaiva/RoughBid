-- Append-only accountability ledger for every estimate pricing write.
-- Snapshots are deliberately JSONB so newly-added unit-rate or formula fields
-- are audited automatically without requiring a trigger change.
create table public.estimate_audit_log (
  id bigint generated always as identity primary key,
  estimate_id uuid not null,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  project_id uuid not null references public.projects(id) on delete restrict,
  operation text not null check (operation in ('insert', 'update')),
  actor_id uuid references auth.users(id) on delete restrict,
  actor_role text not null default coalesce(auth.role(), 'unknown'),
  changed_fields text[] not null,
  before_values jsonb,
  after_values jsonb not null,
  occurred_at timestamptz not null default clock_timestamp(),
  transaction_id bigint not null default txid_current(),
  constraint estimate_audit_insert_has_no_before check (
    operation <> 'insert' or before_values is null
  ),
  constraint estimate_audit_update_has_before check (
    operation <> 'update' or before_values is not null
  )
);

create index estimate_audit_log_estimate_idx
  on public.estimate_audit_log(estimate_id, occurred_at, id);
create index estimate_audit_log_workspace_idx
  on public.estimate_audit_log(workspace_id, occurred_at desc);

alter table public.estimate_audit_log enable row level security;

create policy estimate_audit_log_select_access on public.estimate_audit_log
  for select to authenticated
  using (private.has_workspace_access(workspace_id) and private.has_product_access());

-- There are intentionally no INSERT, UPDATE, or DELETE policies. Application
-- users can read their workspace ledger, but only the estimate trigger can add
-- entries.
revoke insert, update, delete, truncate on public.estimate_audit_log
  from public, anon, authenticated;
grant select on public.estimate_audit_log to authenticated;

create or replace function private.record_estimate_audit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  old_snapshot jsonb;
  new_snapshot jsonb := to_jsonb(new);
  fields text[];
begin
  if tg_op = 'INSERT' then
    select coalesce(array_agg(key order by key), array[]::text[])
      into fields
      from jsonb_object_keys(new_snapshot) as keys(key);

    insert into public.estimate_audit_log (
      estimate_id, workspace_id, project_id, operation, actor_id,
      actor_role, changed_fields, before_values, after_values
    ) values (
      new.id, new.workspace_id, new.project_id, 'insert', auth.uid(),
      coalesce(auth.role(), 'unknown'), fields, null, new_snapshot
    );
  else
    old_snapshot := to_jsonb(old);
    select coalesce(array_agg(key order by key), array[]::text[])
      into fields
      from jsonb_object_keys(new_snapshot) as keys(key)
      where old_snapshot -> key is distinct from new_snapshot -> key;

    insert into public.estimate_audit_log (
      estimate_id, workspace_id, project_id, operation, actor_id,
      actor_role, changed_fields, before_values, after_values
    ) values (
      new.id, new.workspace_id, new.project_id, 'update', auth.uid(),
      coalesce(auth.role(), 'unknown'), fields, old_snapshot, new_snapshot
    );
  end if;
  return new;
end;
$$;

revoke all on function private.record_estimate_audit()
  from public, anon, authenticated;

create trigger estimates_record_immutable_audit
  after insert or update on public.estimates
  for each row execute function private.record_estimate_audit();

create or replace function private.reject_estimate_audit_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'estimate audit records are immutable'
    using errcode = '55000';
end;
$$;

revoke all on function private.reject_estimate_audit_mutation()
  from public, anon, authenticated;

-- This also protects the ledger from accidental privileged UPDATE/DELETE calls.
create trigger estimate_audit_log_reject_mutation
  before update or delete on public.estimate_audit_log
  for each row execute function private.reject_estimate_audit_mutation();

comment on table public.estimate_audit_log is
  'Immutable history of estimate numbers (version), unit-rate inputs, pricing formulas, and calculated prices.';
