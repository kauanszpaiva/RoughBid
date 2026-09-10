-- Commercial launch controls: a company-wide provider-spend breaker and the
-- first real workspace Marketplace entitlement (Supplier Price Import).

create table public.provider_spend_policy (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default true,
  rolling_window interval not null default interval '24 hours' check (rolling_window > interval '0'),
  spend_cap_usd numeric(12,6) not null check (spend_cap_usd > 0),
  call_reservation_usd numeric(12,6) not null check (call_reservation_usd > 0 and call_reservation_usd <= spend_cap_usd),
  updated_at timestamptz not null default now()
);

insert into public.provider_spend_policy(singleton, enabled, spend_cap_usd, call_reservation_usd)
values(true, true, 25.00, 2.50);

create table public.provider_spend_reservations (
  event_id uuid primary key references public.api_usage_events(id) on delete restrict,
  job_id uuid not null references public.plan_reading_jobs(id) on delete restrict,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  user_id uuid references auth.users(id) on delete set null,
  provider text not null,
  model text not null,
  status text not null default 'reserved' check (status in ('reserved','captured')),
  reserved_usd numeric(12,6) not null check (reserved_usd > 0),
  estimated_cost_usd numeric(12,6) check (estimated_cost_usd is null or estimated_cost_usd >= 0),
  telemetry_known boolean not null default false,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  constraint provider_spend_job_fkey
    foreign key (job_id) references public.plan_reading_jobs(id) on delete restrict
);

create index provider_spend_window_idx on public.provider_spend_reservations(created_at desc);
alter table public.provider_spend_policy enable row level security;
alter table public.provider_spend_reservations enable row level security;
revoke all on public.provider_spend_policy, public.provider_spend_reservations from public, anon, authenticated;
grant all on public.provider_spend_policy, public.provider_spend_reservations to service_role;

create function public.reserve_provider_spend(
  p_event_id uuid, p_job_id uuid, p_workspace_id uuid, p_user_id uuid,
  p_provider text, p_model text
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  policy public.provider_spend_policy;
  used numeric(12,6);
  reservation public.provider_spend_reservations;
begin
  if p_provider <> 'gemini' or btrim(coalesce(p_model,'')) = '' then
    raise exception 'Provider spend identity is invalid';
  end if;
  select * into policy from public.provider_spend_policy where singleton for update;
  if not found or not policy.enabled then raise exception 'Company AI spend is disabled'; end if;

  select * into reservation from public.provider_spend_reservations where event_id=p_event_id;
  if found then
    if reservation.job_id<>p_job_id or reservation.workspace_id<>p_workspace_id
       or reservation.user_id is distinct from p_user_id or reservation.provider<>p_provider or reservation.model<>p_model then
      raise exception 'Provider spend reservation identity mismatch';
    end if;
    return to_jsonb(reservation);
  end if;

  perform 1 from public.plan_reading_jobs
  where id=p_job_id and workspace_id=p_workspace_id and requested_by=p_user_id
  for share;
  if not found then raise exception 'Provider spend job is not authorized'; end if;

  select coalesce(sum(case
    when status='captured' and telemetry_known then estimated_cost_usd
    else reserved_usd end),0)
  into used
  from public.provider_spend_reservations
  where created_at > now()-policy.rolling_window;

  if used + policy.call_reservation_usd > policy.spend_cap_usd then
    raise exception 'Company AI spend limit reached';
  end if;

  insert into public.provider_spend_reservations(
    event_id,job_id,workspace_id,user_id,provider,model,reserved_usd
  ) values(
    p_event_id,p_job_id,p_workspace_id,p_user_id,p_provider,p_model,policy.call_reservation_usd
  ) returning * into reservation;
  return to_jsonb(reservation);
end $$;

create function public.capture_provider_spend(p_event_id uuid, p_estimated_cost_usd numeric default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_estimated_cost_usd is not null and p_estimated_cost_usd < 0 then
    raise exception 'Provider cost cannot be negative';
  end if;
  update public.provider_spend_reservations
  set status='captured', estimated_cost_usd=p_estimated_cost_usd,
      telemetry_known=p_estimated_cost_usd is not null, settled_at=now()
  where event_id=p_event_id;
  if not found then raise exception 'Provider spend reservation not found'; end if;
end $$;

revoke all on function public.reserve_provider_spend(uuid,uuid,uuid,uuid,text,text),
  public.capture_provider_spend(uuid,numeric) from public,anon,authenticated;
grant execute on function public.reserve_provider_spend(uuid,uuid,uuid,uuid,text,text),
  public.capture_provider_spend(uuid,numeric) to service_role;

-- Supplier CSV import is the first Marketplace SKU. Other proposed feeds stay
-- unavailable until their underlying data and licenses are production-ready.
alter table public.marketplace_entitlements
  add column if not exists stripe_subscription_id text,
  add column if not exists stripe_price_id text,
  add column if not exists mode text check (mode in ('test','live')),
  add column if not exists stripe_status text,
  add column if not exists invoice_paid boolean not null default false,
  add column if not exists last_paid_invoice_id text,
  add column if not exists current_period_end timestamptz,
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists marketplace_entitlement_subscription_idx
  on public.marketplace_entitlements(stripe_subscription_id) where stripe_subscription_id is not null;

alter table public.marketplace_purchases
  add column if not exists stripe_event_id text,
  add column if not exists currency text not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  add column if not exists livemode boolean not null default false;
create unique index if not exists marketplace_purchase_event_idx
  on public.marketplace_purchases(stripe_event_id) where stripe_event_id is not null;

create table public.marketplace_checkout_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  feed_id text not null check (feed_id='supplier_import'),
  price_id text not null,
  mode text not null check (mode in ('test','live')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique(user_id,workspace_id,feed_id,mode)
);
alter table public.marketplace_checkout_attempts enable row level security;
revoke all on public.marketplace_checkout_attempts from public,anon,authenticated;
grant all on public.marketplace_checkout_attempts to service_role;

create function public.claim_marketplace_checkout(
  p_user_id uuid,p_workspace_id uuid,p_feed_id text,p_price_id text,p_mode text
) returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare a public.marketplace_checkout_attempts;
begin
  if p_feed_id<>'supplier_import' or p_mode not in ('test','live') or p_price_id not like 'price_%' then
    raise exception 'Marketplace checkout identity is invalid';
  end if;
  perform 1 from public.profiles where id=p_user_id and not is_platform_admin for update;
  if not found then raise exception 'Complimentary owner accounts cannot open checkout'; end if;
  if not exists(select 1 from public.workspace_members
    where workspace_id=p_workspace_id and user_id=p_user_id and role='admin') then
    raise exception 'Workspace administrator access is required';
  end if;
  if coalesce((public.get_pilot_access(p_user_id)->>'active')::boolean,true) then
    raise exception 'Sponsored pilot is active; Marketplace checkout is available after expiry';
  end if;
  perform 1 from public.stripe_price_mappings
  where internal_id=p_feed_id and internal_type='marketplace_feed' and stripe_price_id=p_price_id and mode=p_mode and active;
  if not found then raise exception 'Marketplace price is not approved'; end if;
  if exists(select 1 from public.marketplace_entitlements
    where workspace_id=p_workspace_id and feed_id=p_feed_id
      and status in ('trialing','active') and invoice_paid and current_period_end>now()) then
    raise exception 'Marketplace access is already active';
  end if;
  select * into a from public.marketplace_checkout_attempts
  where user_id=p_user_id and workspace_id=p_workspace_id and feed_id=p_feed_id and mode=p_mode for update;
  if found and a.expires_at>now() then
    if a.price_id<>p_price_id then raise exception 'A different Marketplace checkout is still open'; end if;
    return to_jsonb(a);
  end if;
  insert into public.marketplace_checkout_attempts(user_id,workspace_id,feed_id,price_id,mode,expires_at)
  values(p_user_id,p_workspace_id,p_feed_id,p_price_id,p_mode,date_trunc('second',now())+interval '1 hour')
  on conflict(user_id,workspace_id,feed_id,mode) do update set
    id=gen_random_uuid(),price_id=excluded.price_id,expires_at=excluded.expires_at,created_at=now()
  returning * into a;
  return to_jsonb(a);
end $$;

drop function public.process_stripe_event(text,text,boolean,uuid,text,text,text,text,timestamptz,boolean,bigint);
create function public.process_stripe_event(
  p_event_id text,p_event_type text,p_livemode boolean,
  p_user_id uuid default null,p_customer_id text default null,p_subscription_id text default null,
  p_price_id text default null,p_status text default null,p_period_end timestamptz default null,
  p_invoice_paid boolean default false,p_sync_revision bigint default null,
  p_marketplace_workspace_id uuid default null,p_marketplace_feed_id text default null,
  p_marketplace_invoice_id text default null,p_marketplace_checkout_session_id text default null,
  p_marketplace_amount_paid integer default null,p_marketplace_currency text default null,
  p_marketplace_force_revoke boolean default false
) returns boolean language plpgsql security definer set search_path=public,private,pg_temp as $$
declare
  current_revision bigint;
  existing public.billing_customers;
  existing_entitlement public.marketplace_entitlements;
  entitlement_status text;
  mode_value text := case when p_livemode then 'live' else 'test' end;
begin
  insert into public.stripe_events(event_id,event_type,livemode) values(p_event_id,p_event_type,p_livemode)
  on conflict(event_id) do nothing;
  if not found then return false; end if;
  if p_user_id is null then return true; end if;

  select revision into current_revision from public.billing_subscription_sync where subscription_id=p_subscription_id for update;
  if p_sync_revision is null or current_revision is null then raise exception 'Current Stripe verification required'; end if;
  if current_revision<>p_sync_revision then return true; end if;
  perform 1 from public.profiles where id=p_user_id for update;
  if not found then raise exception 'Billing user identity invalid'; end if;
  select * into existing from public.billing_customers where user_id=p_user_id for update;
  if existing.stripe_customer_id is not null and existing.stripe_customer_id<>p_customer_id then
    raise exception 'Billing customer identity mismatch';
  end if;

  if p_marketplace_feed_id is not null then
    if p_marketplace_feed_id<>'supplier_import' or p_marketplace_workspace_id is null
       or not exists(select 1 from public.workspace_members
         where workspace_id=p_marketplace_workspace_id and user_id=p_user_id and role='admin') then
      raise exception 'Marketplace workspace identity invalid';
    end if;
    perform 1 from public.stripe_price_mappings where internal_id=p_marketplace_feed_id
      and internal_type='marketplace_feed' and stripe_price_id=p_price_id and mode=mode_value and active;
    if not found then raise exception 'Marketplace Stripe price is not approved'; end if;
    select * into existing_entitlement from public.marketplace_entitlements
      where workspace_id=p_marketplace_workspace_id and feed_id=p_marketplace_feed_id for update;
    if existing_entitlement.stripe_subscription_id is not null
       and existing_entitlement.stripe_subscription_id<>p_subscription_id
       and existing_entitlement.status in ('trialing','active') then
      raise exception 'Duplicate Marketplace subscription requires review';
    end if;
    entitlement_status := case
      when p_marketplace_force_revoke then 'revoked'
      when p_status='canceled' then 'canceled'
      when p_period_end is null or p_period_end<=now() then 'expired'
      when p_status='trialing' and p_invoice_paid then 'trialing'
      when p_status='active' and p_invoice_paid then 'active'
      else 'revoked' end;
    insert into public.marketplace_entitlements(
      workspace_id,feed_id,status,region_coverage,stripe_subscription_item_id,source_license,created_by,
      stripe_subscription_id,stripe_price_id,mode,stripe_status,invoice_paid,last_paid_invoice_id,current_period_end,updated_at
    ) values(
      p_marketplace_workspace_id,p_marketplace_feed_id,entitlement_status,'{}',null,
      'Customer-supplied data; RoughBid CSV import feature license',p_user_id,p_subscription_id,p_price_id,
      mode_value,p_status,case when p_marketplace_force_revoke then false else p_invoice_paid end,
      case when p_invoice_paid and not p_marketplace_force_revoke then p_marketplace_invoice_id else null end,p_period_end,now()
    ) on conflict(workspace_id,feed_id) do update set
      status=case when public.marketplace_entitlements.status='revoked' and excluded.status in ('active','trialing')
          and (excluded.last_paid_invoice_id is null or excluded.last_paid_invoice_id=public.marketplace_entitlements.last_paid_invoice_id)
        then 'revoked' else excluded.status end,
      created_by=excluded.created_by,stripe_subscription_id=excluded.stripe_subscription_id,
      stripe_price_id=excluded.stripe_price_id,mode=excluded.mode,stripe_status=excluded.stripe_status,
      invoice_paid=case when public.marketplace_entitlements.status='revoked' and excluded.status in ('active','trialing')
          and (excluded.last_paid_invoice_id is null or excluded.last_paid_invoice_id=public.marketplace_entitlements.last_paid_invoice_id)
        then false else excluded.invoice_paid end,
      last_paid_invoice_id=coalesce(excluded.last_paid_invoice_id,public.marketplace_entitlements.last_paid_invoice_id),
      current_period_end=excluded.current_period_end,updated_at=now();
    if p_invoice_paid and not p_marketplace_force_revoke and p_marketplace_invoice_id is not null then
      if p_marketplace_amount_paid is null or p_marketplace_amount_paid<0 or p_marketplace_currency<>'usd' then
        raise exception 'Marketplace invoice amount is invalid';
      end if;
      insert into public.marketplace_purchases(
        workspace_id,feed_id,stripe_checkout_session_id,stripe_invoice_id,amount_paid_usd,data_cogs_usd,
        stripe_event_id,currency,livemode
      ) values(
        p_marketplace_workspace_id,p_marketplace_feed_id,p_marketplace_checkout_session_id,p_marketplace_invoice_id,
        p_marketplace_amount_paid::numeric/100,8.00,p_event_id,p_marketplace_currency,p_livemode
      ) on conflict(stripe_invoice_id) do nothing;
    end if;
    return true;
  end if;

  if existing.stripe_subscription_id is not null and existing.stripe_subscription_id<>p_subscription_id then
    if p_status in ('canceled','incomplete_expired') then return true; end if;
    if existing.subscription_status not in ('canceled','incomplete_expired') then raise exception 'Duplicate subscription requires review'; end if;
  end if;
  insert into public.billing_customers(user_id,stripe_customer_id,stripe_subscription_id,stripe_price_id,subscription_status,current_period_end,invoice_paid)
  values(p_user_id,p_customer_id,p_subscription_id,p_price_id,p_status,p_period_end,p_invoice_paid)
  on conflict(user_id) do update set stripe_customer_id=excluded.stripe_customer_id,stripe_subscription_id=excluded.stripe_subscription_id,
    stripe_price_id=excluded.stripe_price_id,subscription_status=excluded.subscription_status,current_period_end=excluded.current_period_end,
    invoice_paid=excluded.invoice_paid,updated_at=now();
  return true;
end $$;

revoke all on function public.claim_marketplace_checkout(uuid,uuid,text,text,text),
  public.process_stripe_event(text,text,boolean,uuid,text,text,text,text,timestamptz,boolean,bigint,uuid,text,text,text,integer,text,boolean)
  from public,anon,authenticated;
grant execute on function public.claim_marketplace_checkout(uuid,uuid,text,text,text),
  public.process_stripe_event(text,text,boolean,uuid,text,text,text,text,timestamptz,boolean,bigint,uuid,text,text,text,integer,text,boolean)
  to service_role;

comment on table public.provider_spend_policy is
  'Company-wide rolling Gemini spend circuit breaker. A reservation is required before every generation call.';
comment on table public.marketplace_checkout_attempts is
  'Idempotent, workspace-scoped Checkout claims for approved RoughBid Marketplace SKUs.';
