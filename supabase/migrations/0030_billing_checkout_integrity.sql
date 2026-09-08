-- Durable checkout idempotency and current-state subscription reconciliation.
-- These functions are exclusively called by the authenticated server after
-- checking owner status or verifying a Stripe webhook signature.
alter table public.billing_customers add column if not exists invoice_paid boolean not null default false;

create table public.billing_checkout_attempts (
  user_id uuid primary key references auth.users(id),
  id uuid not null unique default gen_random_uuid(),
  price_key text not null check (price_key in ('plan_starter','plan_pro','plan_team')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table public.billing_subscription_sync (
  subscription_id text primary key,
  revision bigint not null default 1
);
alter table public.billing_checkout_attempts enable row level security;
alter table public.billing_subscription_sync enable row level security;
revoke all on public.billing_checkout_attempts, public.billing_subscription_sync from public, anon, authenticated;
grant all on public.billing_checkout_attempts, public.billing_subscription_sync to service_role;

create function public.claim_billing_checkout(p_user_id uuid, p_price_key text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.billing_checkout_attempts;
begin
  perform 1 from public.profiles where id=p_user_id and not is_platform_admin for update;
  if not found then raise exception 'Complimentary owner accounts cannot open checkout'; end if;
  if coalesce((public.get_pilot_access(p_user_id)->>'active')::boolean,true) then
    raise exception 'Sponsored pilot is active; membership checkout is available after expiry';
  end if;
  if exists (select 1 from public.billing_customers where user_id=p_user_id and subscription_status not in ('canceled','incomplete_expired')) then
    raise exception 'Manage the existing subscription in the billing portal';
  end if;
  select * into a from public.billing_checkout_attempts where user_id=p_user_id;
  if found and a.expires_at > now() then
    if a.price_key <> p_price_key then raise exception 'A different membership checkout is still open'; end if;
    return to_jsonb(a);
  end if;
  insert into public.billing_checkout_attempts(user_id,price_key,expires_at)
  values(p_user_id,p_price_key,date_trunc('second',now())+interval '1 hour')
  on conflict(user_id) do update set id=gen_random_uuid(),price_key=excluded.price_key,expires_at=excluded.expires_at,created_at=now()
  returning * into a;
  return to_jsonb(a);
end $$;

create function public.save_billing_customer(p_user_id uuid,p_customer_id text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare existing text;
begin
  perform 1 from public.profiles where id=p_user_id and not is_platform_admin for update;
  if not found or p_customer_id not like 'cus_%' then raise exception 'Billing identity invalid'; end if;
  select stripe_customer_id into existing from public.billing_customers where user_id=p_user_id;
  if existing is not null and existing <> p_customer_id then raise exception 'Billing customer identity mismatch'; end if;
  insert into public.billing_customers(user_id,stripe_customer_id) values(p_user_id,p_customer_id)
  on conflict(user_id) do update set stripe_customer_id=excluded.stripe_customer_id,updated_at=now();
end $$;

create function public.begin_billing_subscription_sync(p_subscription_id text)
returns bigint language plpgsql security definer set search_path=public,pg_temp as $$
declare value bigint;
begin
  if p_subscription_id not like 'sub_%' then raise exception 'Subscription identity invalid'; end if;
  insert into public.billing_subscription_sync(subscription_id) values(p_subscription_id)
  on conflict(subscription_id) do update set revision=public.billing_subscription_sync.revision+1
  returning revision into value;
  return value;
end $$;

drop function public.process_stripe_event(text,text,boolean,uuid,text,text,text,text,timestamptz);
create function public.process_stripe_event(
  p_event_id text,p_event_type text,p_livemode boolean,
  p_user_id uuid default null,p_customer_id text default null,p_subscription_id text default null,
  p_price_id text default null,p_status text default null,p_period_end timestamptz default null,
  p_invoice_paid boolean default false,p_sync_revision bigint default null
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare current_revision bigint; existing public.billing_customers;
begin
  insert into public.stripe_events(event_id,event_type,livemode) values(p_event_id,p_event_type,p_livemode)
  on conflict(event_id) do nothing;
  if not found then return false; end if;
  if p_user_id is null then return true; end if;

  select revision into current_revision from public.billing_subscription_sync where subscription_id=p_subscription_id for update;
  if p_sync_revision is null or current_revision is null then raise exception 'Current Stripe verification required'; end if;
  if current_revision <> p_sync_revision then return true; end if;
  perform 1 from public.profiles where id=p_user_id for update;
  if not found then raise exception 'Billing user identity invalid'; end if;
  select * into existing from public.billing_customers where user_id=p_user_id for update;
  if existing.stripe_customer_id is not null and existing.stripe_customer_id <> p_customer_id then raise exception 'Billing customer identity mismatch'; end if;
  if existing.stripe_subscription_id is not null and existing.stripe_subscription_id <> p_subscription_id then
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

revoke all on function public.claim_billing_checkout(uuid,text), public.save_billing_customer(uuid,text), public.begin_billing_subscription_sync(text), public.process_stripe_event(text,text,boolean,uuid,text,text,text,text,timestamptz,boolean,bigint) from public,anon,authenticated;
grant execute on function public.claim_billing_checkout(uuid,text), public.save_billing_customer(uuid,text), public.begin_billing_subscription_sync(text), public.process_stripe_event(text,text,boolean,uuid,text,text,text,text,timestamptz,boolean,bigint) to service_role;
