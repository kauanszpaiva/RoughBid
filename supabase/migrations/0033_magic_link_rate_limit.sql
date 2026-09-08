-- Persistent limits shared by every serverless instance. No email addresses,
-- IP addresses, auth identities, tokens or provider error payloads are stored.
create table public.auth_magic_link_rate_state (
  singleton boolean primary key default true check(singleton)
);
insert into public.auth_magic_link_rate_state values(true);
create table public.auth_magic_link_attempts (
  id uuid primary key default gen_random_uuid(),
  email_hash text not null check(email_hash ~ '^[a-f0-9]{64}$'),
  origin_hash text not null check(origin_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);
create index auth_magic_link_email_time_idx on public.auth_magic_link_attempts(email_hash,created_at desc);
create index auth_magic_link_origin_time_idx on public.auth_magic_link_attempts(origin_hash,created_at desc);
create index auth_magic_link_time_idx on public.auth_magic_link_attempts(created_at);
alter table public.auth_magic_link_rate_state enable row level security;
alter table public.auth_magic_link_attempts enable row level security;
revoke all on public.auth_magic_link_rate_state,public.auth_magic_link_attempts from public,anon,authenticated;
-- Even the service role cannot reset quotas through direct table operations.
revoke all on public.auth_magic_link_rate_state,public.auth_magic_link_attempts from service_role;

create function public.reserve_magic_link_attempt(p_email_hash text,p_origin_hash text,p_origin_unknown boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare at_time timestamptz; retry_at timestamptz; n integer; oldest timestamptz; latest timestamptz;
begin
  if p_email_hash is null or p_email_hash !~ '^[a-f0-9]{64}$' or p_origin_hash is null or p_origin_hash !~ '^[a-f0-9]{64}$' or p_origin_unknown is null then
    raise exception 'Invalid rate-limit identity';
  end if;
  -- One lock covers all three dimensions, so parallel functions cannot each
  -- observe spare capacity and all issue paid emails. No process-local cache.
  perform 1 from public.auth_magic_link_rate_state where singleton for update;
  if not found then raise exception 'Magic-link limiter unavailable'; end if;
  at_time := clock_timestamp();
  retry_at := at_time;
  -- At most 1000 successful reservations/day; denied traffic creates no rows.
  -- Delete expired pseudonymous records without needing a separate scheduler.
  delete from public.auth_magic_link_attempts where created_at<=at_time-interval '24 hours';

  select count(*),min(created_at),max(created_at) into n,oldest,latest from public.auth_magic_link_attempts
    where email_hash=p_email_hash and created_at>at_time-interval '1 hour';
  if latest>at_time-interval '1 minute' then retry_at:=greatest(retry_at,latest+interval '1 minute'); end if;
  if n>=5 then retry_at:=greatest(retry_at,oldest+interval '1 hour'); end if;
  select count(*),min(created_at) into n,oldest from public.auth_magic_link_attempts where email_hash=p_email_hash;
  if n>=10 then retry_at:=greatest(retry_at,oldest+interval '24 hours'); end if;

  select count(*),min(created_at) into n,oldest from public.auth_magic_link_attempts
    where origin_hash=p_origin_hash and created_at>at_time-interval '10 minutes';
  if n >= (case when p_origin_unknown then 10 else 30 end) then retry_at:=greatest(retry_at,oldest+interval '10 minutes'); end if;
  select count(*),min(created_at) into n,oldest from public.auth_magic_link_attempts
    where origin_hash=p_origin_hash and created_at>at_time-interval '1 hour';
  if n >= (case when p_origin_unknown then 30 else 120 end) then retry_at:=greatest(retry_at,oldest+interval '1 hour'); end if;

  select count(*),min(created_at) into n,oldest from public.auth_magic_link_attempts where created_at>at_time-interval '1 hour';
  if n>=200 then retry_at:=greatest(retry_at,oldest+interval '1 hour'); end if;
  select count(*),min(created_at) into n,oldest from public.auth_magic_link_attempts;
  if n>=1000 then retry_at:=greatest(retry_at,oldest+interval '24 hours'); end if;

  if retry_at>at_time then
    return jsonb_build_object('allowed',false,'retry_after_seconds',greatest(1,ceil(extract(epoch from retry_at-at_time))::integer));
  end if;
  insert into public.auth_magic_link_attempts(email_hash,origin_hash,created_at) values(p_email_hash,p_origin_hash,at_time);
  return jsonb_build_object('allowed',true,'retry_after_seconds',0);
end;
$$;
revoke all on function public.reserve_magic_link_attempt(text,text,boolean) from public,anon,authenticated;
grant execute on function public.reserve_magic_link_attempt(text,text,boolean) to service_role;
