-- Capability-specific durable worker availability.
-- A live worker is not sufficient by itself: the API may enqueue paid work only
-- when at least one fresh worker has the paid provider configured, and owner-free
-- work only when at least one fresh worker has the isolated free provider.

alter table private.ai_plan_worker_heartbeats
  add column if not exists paid_enabled boolean not null default false,
  add column if not exists free_enabled boolean not null default false;

drop function if exists public.touch_ai_plan_worker(text);
drop function if exists public.ai_plan_worker_available();

create function public.touch_ai_plan_worker(
  p_worker_id text,
  p_paid_enabled boolean,
  p_free_enabled boolean
)
returns boolean language plpgsql security definer set search_path = public, private, pg_temp as $$
begin
  if p_worker_id is null or char_length(trim(p_worker_id)) not between 1 and 160 then
    raise exception 'Invalid worker id';
  end if;
  insert into private.ai_plan_worker_heartbeats(worker_id, heartbeat_at, paid_enabled, free_enabled)
    values(trim(p_worker_id), now(), coalesce(p_paid_enabled,false), coalesce(p_free_enabled,false))
    on conflict (worker_id) do update set
      heartbeat_at=excluded.heartbeat_at,
      paid_enabled=excluded.paid_enabled,
      free_enabled=excluded.free_enabled;
  return true;
end $$;

create function public.ai_plan_worker_available(p_entitlement text)
returns boolean language plpgsql stable security definer set search_path = public, private, pg_temp as $$
begin
  if p_entitlement not in ('paid','owner_free') then
    raise exception 'Invalid AI plan entitlement';
  end if;
  return exists (
    select 1
    from private.ai_plan_worker_heartbeats
    where heartbeat_at >= now() - interval '90 seconds'
      and case when p_entitlement='paid' then paid_enabled else free_enabled end
  );
end $$;

revoke all on function public.touch_ai_plan_worker(text,boolean,boolean) from public,anon,authenticated;
revoke all on function public.ai_plan_worker_available(text) from public,anon,authenticated;
grant execute on function public.touch_ai_plan_worker(text,boolean,boolean) to service_role;
grant execute on function public.ai_plan_worker_available(text) to service_role;
