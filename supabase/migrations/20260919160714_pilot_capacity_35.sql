-- Align the limited PrimeBid pilot seat ceiling with the approved KSP cohort size.
-- This change does not send invitations or activate any new account. Only the
-- platform owner can issue invitations, and all existing pilot budget / quota
-- guards remain unchanged.

do $$
begin
  if (select count(*) from public.pilot_enrollments) > 35 then
    raise exception 'Cannot lower pilot capacity below existing enrollments';
  end if;
end
$$;

alter table public.pilot_cohorts
  drop constraint if exists pilot_cohorts_capacity_check;

alter table public.pilot_cohorts
  add constraint pilot_cohorts_capacity_check
  check (capacity between 1 and 35);

update public.pilot_cohorts
set capacity = 35
where code = 'founding-pilot-60d';

alter table public.pilot_cohorts
  alter column capacity set default 35;

create or replace function public.issue_pilot_invitation(
  p_admin_user_id uuid,
  p_email text,
  p_token_hash text,
  p_preset text default 'pilot60'
)
returns jsonb
language plpgsql
security definer
set search_path = public,private,pg_temp
as $$
declare
  c public.pilot_cohorts;
  i public.pilot_invitations;
begin
  if not exists(
    select 1 from public.profiles
    where id=p_admin_user_id and is_platform_admin
  ) then
    raise exception 'Platform administrator access required';
  end if;

  if p_email is null
     or lower(btrim(p_email)) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or char_length(p_email)>254 then
    raise exception 'Valid recipient email required';
  end if;

  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid invitation token';
  end if;

  if p_preset is null or p_preset not in ('sample1','month1','pilot60') then
    raise exception 'Invalid pilot preset';
  end if;

  select * into c
  from public.pilot_cohorts
  where code='founding-pilot-60d'
  for update;

  if not found or not c.enabled then
    raise exception 'Pilot enrollment is unavailable';
  end if;

  select * into i
  from public.pilot_invitations
  where cohort_id=c.id and email=lower(btrim(p_email));

  -- Resending never rotates a token, changes the offer, or extends access.
  if found then
    if i.token_hash <> p_token_hash then
      raise exception 'Invitation token configuration changed; existing invitation preserved';
    end if;
    return to_jsonb(i) - 'token_hash';
  end if;

  if (
    select count(*)
    from public.pilot_invitations
    where cohort_id=c.id
      and (accepted_at is not null or (revoked_at is null and expires_at>now()))
  ) >= c.capacity then
    raise exception 'Pilot cohort is full (% recipients maximum)', c.capacity;
  end if;

  insert into public.pilot_invitations(
    cohort_id,email,token_hash,preset,created_by
  ) values (
    c.id,lower(btrim(p_email)),p_token_hash,p_preset,p_admin_user_id
  )
  returning * into i;

  return to_jsonb(i) - 'token_hash';
end;
$$;

revoke all on function public.issue_pilot_invitation(uuid,text,text,text)
  from public,anon,authenticated;
grant execute on function public.issue_pilot_invitation(uuid,text,text,text)
  to service_role;
