-- A concurrent webhook may advance the subscription sync revision after
-- another delivery has done its authoritative Stripe read. A stale delivery
-- must roll back its stripe_events claim so Stripe can retry it; recording the
-- event and returning would permanently suppress the fresh delivery.
create or replace function public.process_stripe_event(
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
  if current_revision<>p_sync_revision then raise exception 'Stale Stripe verification must be retried'; end if;
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
