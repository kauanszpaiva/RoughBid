-- RoughBid SaaS controls: private trial provisioning, project membership,
-- credit accounting, marketplace entitlements, AI usage cost tracking, and
-- sensitive-data audit events.

create or replace function private.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'))
  on conflict (id) do nothing;

  insert into public.entitlements (user_id, kind, source, starts_at, expires_at)
  values (new.id, 'access_grant', 'roughbid_free_trial', now(), now() + interval '14 days')
  on conflict do nothing;

  return new;
end;
$$;

drop function if exists public.handle_new_user_profile();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'projects_id_workspace_unique'
      and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects
      add constraint projects_id_workspace_unique
      unique (id, workspace_id);
  end if;
end;
$$;

insert into public.entitlements (user_id, kind, source, starts_at, expires_at)
select p.id, 'access_grant', 'roughbid_free_trial', now(), now() + interval '14 days'
from public.profiles p
where not exists (
  select 1
  from public.entitlements e
  where e.user_id = p.id
    and e.revoked_at is null
    and e.starts_at <= now()
    and (e.expires_at is null or e.expires_at > now())
);

create table public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'estimator', 'viewer')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id),
  constraint project_members_project_workspace_fkey
    foreign key (project_id, workspace_id)
    references public.projects(id, workspace_id)
    on delete cascade
);

create index project_members_workspace_user_idx on public.project_members(workspace_id, user_id);

create or replace function private.has_project_role(target_project uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.project_members pm
    where pm.project_id = target_project
      and pm.user_id = auth.uid()
      and pm.role = any(allowed_roles)
  )
  or exists (
    select 1
    from public.projects p
    where p.id = target_project
      and private.has_workspace_role(
        p.workspace_id,
        case
          when 'admin' = any(allowed_roles) then array['admin']
          when 'estimator' = any(allowed_roles) then array['admin', 'estimator']
          else array['admin', 'estimator', 'viewer']
        end
      )
  );
$$;

revoke all on function private.has_project_role(uuid, text[]) from public, anon, authenticated;
grant execute on function private.has_project_role(uuid, text[]) to authenticated;

create table public.billing_accounts (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  plan_id text,
  status text not null default 'trialing'
    check (status in ('trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused', 'none')),
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  trial_cogs_spent numeric(12,4) not null default 0 check (trial_cogs_spent >= 0 and trial_cogs_spent <= 1.00),
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

create table public.credit_grants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source text not null check (source in ('free_trial', 'subscription', 'credit_pack', 'marketplace', 'manual_adjustment')),
  external_ref text,
  credits_granted numeric(10,2) not null check (credits_granted >= 0),
  credits_remaining numeric(10,2) not null check (credits_remaining >= 0),
  expires_at timestamptz,
  status text not null default 'active' check (status in ('active', 'expired', 'revoked')),
  created_at timestamptz not null default now(),
  constraint credit_grants_remaining_lte_granted check (credits_remaining <= credits_granted)
);

create index credit_grants_workspace_idx on public.credit_grants(workspace_id, status, expires_at);

create table public.credit_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  grant_id uuid references public.credit_grants(id) on delete set null,
  entry_type text not null check (entry_type in ('grant', 'reserve', 'capture', 'release', 'refund', 'adjustment', 'usage')),
  credits_delta numeric(10,2) not null,
  cogs_delta numeric(12,4) not null default 0 check (cogs_delta >= 0),
  idempotency_key text not null unique,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint credit_ledger_project_workspace_fkey
    foreign key (project_id, workspace_id)
    references public.projects(id, workspace_id)
    on delete restrict
);

create index credit_ledger_workspace_idx on public.credit_ledger_entries(workspace_id, created_at desc);
create index credit_ledger_project_idx on public.credit_ledger_entries(project_id, created_at desc);

create table public.project_entitlements (
  project_id uuid primary key references public.projects(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  credit_status text not null default 'trial' check (credit_status in ('trial', 'reserved', 'captured', 'released', 'blocked')),
  reserved_credit_amount numeric(10,2) not null default 0 check (reserved_credit_amount >= 0),
  ai_generation_count integer not null default 0 check (ai_generation_count >= 0),
  api_cogs_spent numeric(12,4) not null default 0 check (api_cogs_spent >= 0),
  cogs_cap numeric(12,4) not null default 0.75 check (cogs_cap >= 0 and cogs_cap <= 1.00),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_entitlements_project_workspace_fkey
    foreign key (project_id, workspace_id)
    references public.projects(id, workspace_id)
    on delete cascade
);

create table public.api_usage_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  provider text not null,
  model text not null,
  operation text not null,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  estimated_cost_usd numeric(12,6) not null default 0 check (estimated_cost_usd >= 0),
  actual_cost_usd numeric(12,6) check (actual_cost_usd is null or actual_cost_usd >= 0),
  sensitive_payload boolean not null default false,
  provider_request_id text,
  created_at timestamptz not null default now(),
  constraint api_usage_project_workspace_fkey
    foreign key (project_id, workspace_id)
    references public.projects(id, workspace_id)
    on delete restrict
);

create index api_usage_workspace_idx on public.api_usage_events(workspace_id, created_at desc);
create index api_usage_project_idx on public.api_usage_events(project_id, created_at desc);

create table public.marketplace_entitlements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  feed_id text not null,
  status text not null default 'trialing' check (status in ('trialing', 'active', 'canceled', 'revoked', 'expired')),
  region_coverage text[] not null default '{}'::text[],
  stripe_subscription_item_id text,
  source_license text,
  created_by uuid references auth.users(id) on delete set null,
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, feed_id)
);

create table public.marketplace_purchases (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  feed_id text not null,
  stripe_checkout_session_id text unique,
  stripe_invoice_id text unique,
  amount_paid_usd numeric(12,2) not null check (amount_paid_usd >= 0),
  data_cogs_usd numeric(12,4) not null default 0 check (data_cogs_usd >= 0),
  created_at timestamptz not null default now()
);

create table public.stripe_price_mappings (
  id uuid primary key default gen_random_uuid(),
  internal_id text not null,
  internal_type text not null check (internal_type in ('plan', 'credit_pack', 'marketplace_feed')),
  stripe_price_id text not null unique,
  mode text not null check (mode in ('test', 'live')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (internal_id, internal_type, mode)
);

create table public.sensitive_data_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  data_type text not null,
  action text not null,
  processor text not null,
  approved_basis text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint sensitive_data_project_workspace_fkey
    foreign key (project_id, workspace_id)
    references public.projects(id, workspace_id)
    on delete restrict
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  target_type text not null,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint audit_events_project_workspace_fkey
    foreign key (project_id, workspace_id)
    references public.projects(id, workspace_id)
    on delete restrict
);

alter table public.project_members enable row level security;
alter table public.billing_accounts enable row level security;
alter table public.credit_grants enable row level security;
alter table public.credit_ledger_entries enable row level security;
alter table public.project_entitlements enable row level security;
alter table public.api_usage_events enable row level security;
alter table public.marketplace_entitlements enable row level security;
alter table public.marketplace_purchases enable row level security;
alter table public.stripe_price_mappings enable row level security;
alter table public.sensitive_data_events enable row level security;
alter table public.audit_events enable row level security;

create policy project_members_select_workspace on public.project_members
  for select to authenticated
  using (private.has_workspace_role(workspace_id, array['admin', 'estimator', 'viewer']) and private.has_product_access());
create policy project_members_insert_admin on public.project_members
  for insert to authenticated
  with check (private.has_workspace_role(workspace_id, array['admin']) and private.has_product_access());
create policy project_members_update_admin on public.project_members
  for update to authenticated
  using (private.has_workspace_role(workspace_id, array['admin']) and private.has_product_access())
  with check (private.has_workspace_role(workspace_id, array['admin']) and private.has_product_access());
create policy project_members_delete_admin on public.project_members
  for delete to authenticated
  using (private.has_workspace_role(workspace_id, array['admin']) and private.has_product_access());

create policy billing_accounts_select_workspace on public.billing_accounts
  for select to authenticated
  using (private.has_workspace_role(workspace_id, array['admin']) and private.has_product_access());
create policy credit_grants_select_workspace on public.credit_grants
  for select to authenticated
  using (private.has_workspace_role(workspace_id, array['admin', 'estimator']) and private.has_product_access());
create policy credit_ledger_select_workspace on public.credit_ledger_entries
  for select to authenticated
  using (private.has_workspace_role(workspace_id, array['admin']) and private.has_product_access());
create policy project_entitlements_select_workspace on public.project_entitlements
  for select to authenticated
  using (private.has_workspace_role(workspace_id, array['admin', 'estimator', 'viewer']) and private.has_product_access());
create policy api_usage_select_workspace on public.api_usage_events
  for select to authenticated
  using (private.has_workspace_role(workspace_id, array['admin']) and private.has_product_access());
create policy marketplace_entitlements_select_workspace on public.marketplace_entitlements
  for select to authenticated
  using (private.has_workspace_role(workspace_id, array['admin', 'estimator', 'viewer']) and private.has_product_access());
create policy marketplace_purchases_select_workspace on public.marketplace_purchases
  for select to authenticated
  using (private.has_workspace_role(workspace_id, array['admin']) and private.has_product_access());
create policy sensitive_data_events_select_workspace on public.sensitive_data_events
  for select to authenticated
  using (private.has_workspace_role(workspace_id, array['admin']) and private.has_product_access());
create policy audit_events_select_workspace on public.audit_events
  for select to authenticated
  using (private.has_workspace_role(workspace_id, array['admin']) and private.has_product_access());

create policy stripe_price_mappings_explicit_deny on public.stripe_price_mappings
  for all to authenticated
  using (false)
  with check (false);

comment on table public.credit_ledger_entries is
  'Workspace-isolated RoughBid credit ledger. Writes are server-only and idempotent.';
comment on table public.api_usage_events is
  'AI and data-provider usage cost trail used to keep trial/project COGS under caps.';
comment on table public.sensitive_data_events is
  'Audit trail for plan, client, address, signature, and other sensitive data processing.';
