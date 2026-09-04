-- RoughBid standalone free trial access.
-- New users get a short no-card access window so the real app can create
-- projects, upload plans, and generate client proposal links after login.

create or replace function public.handle_new_user_profile()
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
