-- Durable pricing-address context. This migration is intentionally repository-only
-- until an explicit production migration approval is given.

create table public.project_pricing_contexts (
  project_id uuid primary key references public.projects(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_address_text text,
  plan_address jsonb,
  pricing_address jsonb,
  address_source text check (address_source in ('plan','project','confirmed_override')),
  address_status text not null check (address_status in ('missing','clear','needs_resolution','resolved')),
  plan_file_id uuid references public.project_files(id) on delete set null,
  plan_job_id uuid references public.plan_reading_jobs(id) on delete set null,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, project_id),
  constraint project_pricing_contexts_resolution_pair check (
    (resolved_by is null and resolved_at is null)
    or (resolved_by is not null and resolved_at is not null)
  ),
  constraint project_pricing_contexts_unresolved_has_no_pricing_address check (
    address_status <> 'needs_resolution' or pricing_address is null
  ),
  constraint project_pricing_contexts_resolved_is_complete check (
    address_status <> 'resolved'
    or (pricing_address is not null and resolved_by is not null and resolved_at is not null)
  )
);

create index project_pricing_contexts_workspace_idx
  on public.project_pricing_contexts(workspace_id, updated_at desc);

alter table public.project_pricing_contexts enable row level security;

-- Evidence lineage is written only through trusted server/service-role code.
-- Authenticated members can inspect it, but cannot directly manufacture or
-- rewrite plan_address, confidence, source excerpts, or resolution provenance.
revoke all on public.project_pricing_contexts from public, anon;
revoke insert, update, delete on public.project_pricing_contexts from authenticated, anon;
grant select on public.project_pricing_contexts to authenticated;

create policy project_pricing_contexts_select_member
on public.project_pricing_contexts for select to authenticated
using (
  private.has_workspace_role(workspace_id, array['admin','estimator','viewer'])
  and private.has_product_access()
);

create or replace function public.resolve_project_pricing_address(p_project_id uuid, p_choice text)
returns public.project_pricing_contexts
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  context_row public.project_pricing_contexts%rowtype;
  selected_address jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_choice not in ('plan', 'project') then
    raise exception 'Pricing address choice must be plan or project';
  end if;

  select * into context_row
  from public.project_pricing_contexts
  where project_id = p_project_id
  for update;

  if not found then
    raise exception 'Pricing context not found';
  end if;

  if not private.has_workspace_role(context_row.workspace_id, array['admin','estimator'])
     or not private.has_product_access() then
    raise exception 'Not authorized to resolve this pricing address' using errcode = '42501';
  end if;

  if p_choice = 'plan' then
    if context_row.plan_address is null then
      raise exception 'No evidenced plan address is available';
    end if;
    selected_address := jsonb_build_object(
      'street_address', context_row.plan_address -> 'street_address',
      'city', context_row.plan_address -> 'city',
      'state', context_row.plan_address -> 'state',
      'postal_code', context_row.plan_address -> 'postal_code',
      'building_lot_unit', context_row.plan_address -> 'building_lot_unit'
    );
  else
    if context_row.project_address_text is null or btrim(context_row.project_address_text) = '' then
      raise exception 'No project address is available';
    end if;
    selected_address := jsonb_build_object('formatted', btrim(context_row.project_address_text));
  end if;

  update public.project_pricing_contexts
  set pricing_address = selected_address,
      address_source = 'confirmed_override',
      address_status = 'resolved',
      resolved_by = auth.uid(),
      resolved_at = now(),
      updated_at = now()
  where project_id = p_project_id
  returning * into context_row;

  return context_row;
end;
$$;

revoke all on function public.resolve_project_pricing_address(uuid, text) from public, anon;
grant execute on function public.resolve_project_pricing_address(uuid, text) to authenticated;
