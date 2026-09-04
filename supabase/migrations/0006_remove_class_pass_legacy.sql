alter table public.entitlements
  drop constraint if exists entitlements_kind_check,
  drop constraint if exists class_pass_is_exactly_60_days;

update public.entitlements
  set kind = 'access_grant',
      source = case when source = 'class_pass_token' then 'access_grant_token' else source end
  where kind = 'class_pass';

alter table public.entitlements
  add constraint entitlements_kind_check check (kind in ('access_grant', 'subscription', 'admin'));

alter table if exists public.class_pass_tokens
  rename to access_grant_tokens;

alter table if exists public.access_grant_tokens
  drop constraint if exists class_pass_token_expiry,
  drop constraint if exists class_pass_redemption_complete;

alter table if exists public.access_grant_tokens
  add constraint access_grant_token_expiry check (expires_at > starts_at),
  add constraint access_grant_redemption_complete check (
    (redeemed_at is null and redeemed_by is null and workspace_id is null)
    or (redeemed_at is not null and redeemed_by is not null and workspace_id is not null)
  );

drop function if exists public.redeem_class_pass(text, text);

create or replace function public.redeem_access_grant(token_digest text, workspace_name text default 'My Workspace')
returns table (workspace_id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
declare
  grant_record public.access_grant_tokens%rowtype;
  new_workspace_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if token_digest !~ '^[0-9a-f]{64}$' then raise exception 'Invalid access grant token'; end if;
  if char_length(trim(workspace_name)) not between 1 and 120 then raise exception 'Invalid workspace name'; end if;

  select * into grant_record from public.access_grant_tokens
    where token_hash = token_digest for update;
  if not found or grant_record.redeemed_at is not null or grant_record.starts_at > now() or grant_record.expires_at <= now() then
    raise exception 'Access grant is invalid, expired, or already redeemed';
  end if;

  insert into public.workspaces (name, created_by)
    values (trim(workspace_name), auth.uid()) returning id into new_workspace_id;
  insert into public.entitlements (user_id, kind, source, external_ref, starts_at, expires_at)
    values (auth.uid(), 'access_grant', 'access_grant_token', grant_record.id::text,
            grant_record.starts_at, grant_record.expires_at);
  update public.access_grant_tokens set redeemed_at = now(), redeemed_by = auth.uid(),
    workspace_id = new_workspace_id where id = grant_record.id;
  return query select new_workspace_id, grant_record.expires_at;
end;
$$;

revoke all on function public.redeem_access_grant(text, text) from public, anon;
grant execute on function public.redeem_access_grant(text, text) to authenticated;
