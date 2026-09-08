create or replace function public.accept_workspace_invite(invite_token_digest text)
returns table (workspace_id uuid, role text)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  invite public.workspace_invites%rowtype;
  signed_in_email text;
  target_workspace_id uuid;
  assigned_role text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if invite_token_digest !~ '^[0-9a-f]{64}$' then raise exception 'Invalid invite token'; end if;

  select * into invite
  from public.workspace_invites
  where token_hash = invite_token_digest
  for update;

  if not found or invite.accepted_at is not null or invite.revoked_at is not null or invite.expires_at <= now() then
    raise exception 'Invite is invalid, expired, or already used';
  end if;

  select lower(email) into signed_in_email
  from auth.users
  where id = auth.uid();

  if signed_in_email is null or signed_in_email <> invite.email then
    raise exception 'Invite email does not match the signed-in user';
  end if;

  target_workspace_id := invite.workspace_id;
  assigned_role := invite.role;

  insert into public.workspace_members as wm (workspace_id, user_id, role)
  values (target_workspace_id, auth.uid(), assigned_role)
  on conflict on constraint workspace_members_pkey do update set
    role = case
      when wm.role = 'admin' then 'admin'
      else excluded.role
    end;

  update public.workspace_invites
    set accepted_at = now(), accepted_by = auth.uid()
    where id = invite.id;

  return query select target_workspace_id, assigned_role;
end;
$$;

revoke all on function public.accept_workspace_invite(text) from public, anon;
grant execute on function public.accept_workspace_invite(text) to authenticated;
