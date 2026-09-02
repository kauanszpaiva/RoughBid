-- Atomically claim each Stripe event and mirror subscription state. This function
-- is called only by the server's service-role repository after signature checking.
create or replace function public.process_stripe_event(
  p_event_id text, p_event_type text, p_livemode boolean,
  p_user_id uuid default null, p_customer_id text default null,
  p_subscription_id text default null, p_price_id text default null,
  p_status text default null, p_period_end timestamptz default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.stripe_events (event_id, event_type, livemode)
  values (p_event_id, p_event_type, p_livemode)
  on conflict (event_id) do nothing;

  if not found then
    return false;
  end if;

  if p_user_id is not null then
    insert into public.billing_customers (
      user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
      subscription_status, current_period_end, updated_at
    ) values (
      p_user_id, p_customer_id, p_subscription_id, p_price_id,
      p_status, p_period_end, now()
    )
    on conflict (user_id) do update set
      stripe_customer_id = excluded.stripe_customer_id,
      stripe_subscription_id = excluded.stripe_subscription_id,
      stripe_price_id = excluded.stripe_price_id,
      subscription_status = excluded.subscription_status,
      current_period_end = excluded.current_period_end,
      updated_at = now();
  end if;

  return true;
end;
$$;

revoke all on function public.process_stripe_event(text, text, boolean, uuid, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.process_stripe_event(text, text, boolean, uuid, text, text, text, text, timestamptz) to service_role;
