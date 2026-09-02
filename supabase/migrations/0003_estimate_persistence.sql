-- Derived values are calculated by packages/domain and persisted verbatim here.
alter table public.estimates
  add column cost_with_overhead numeric(14,2) not null default 0 check (cost_with_overhead >= 0),
  add column markup_amount numeric(14,2) not null default 0 check (markup_amount >= 0),
  add column gross_margin_percent numeric(10,6) not null default 0,
  add column finalized_at timestamptz;

alter table public.estimates
  add constraint estimates_finalized_status_consistent check (
    (status = 'draft' and finalized_at is null)
    or (status = 'final' and finalized_at is not null)
  );

create or replace function public.protect_estimate_lifecycle()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status = 'final' then
    raise exception 'final estimates are immutable';
  end if;
  if new.version <> old.version or new.project_id <> old.project_id then
    raise exception 'estimate version and project cannot be changed';
  end if;
  if new.status = 'final' and new.finalized_at is null then
    new.finalized_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger estimates_protect_lifecycle
  before update on public.estimates
  for each row execute function public.protect_estimate_lifecycle();

-- API repositories take this lock in the same transaction before selecting
-- max(version) + 1, making allocation safe across concurrent draft creation.
comment on constraint estimates_project_id_version_key on public.estimates is
  'Allocate versions transactionally under pg_advisory_xact_lock(hashtextextended(project_id::text, 0)).';
