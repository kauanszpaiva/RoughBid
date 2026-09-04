create table public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null check (char_length(email) between 3 and 254 and email = lower(email)),
  role text not null default 'estimator' check (role in ('estimator', 'viewer')),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references auth.users(id) on delete restrict,
  accepted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  revoked_at timestamptz,
  constraint workspace_invite_expiry_after_create check (expires_at > created_at),
  constraint workspace_invite_acceptance_complete check (
    (accepted_at is null and accepted_by is null)
    or (accepted_at is not null and accepted_by is not null)
  )
);

create index workspace_invites_workspace_idx
  on public.workspace_invites(workspace_id, created_at desc);
create index workspace_invites_token_active_idx
  on public.workspace_invites(token_hash)
  where accepted_at is null and revoked_at is null;

alter table public.workspace_invites enable row level security;

create policy workspace_invites_select_admin on public.workspace_invites
  for select to authenticated
  using (private.has_workspace_role(workspace_id, array['admin']));

create policy workspace_invites_insert_admin on public.workspace_invites
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and private.has_workspace_role(workspace_id, array['admin'])
  );

create policy workspace_invites_update_admin on public.workspace_invites
  for update to authenticated
  using (private.has_workspace_role(workspace_id, array['admin']))
  with check (private.has_workspace_role(workspace_id, array['admin']));

create or replace function public.accept_workspace_invite(invite_token_digest text)
returns table (workspace_id uuid, role text)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  invite public.workspace_invites%rowtype;
  signed_in_email text;
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

  insert into public.workspace_members (workspace_id, user_id, role)
  values (invite.workspace_id, auth.uid(), invite.role)
  on conflict (workspace_id, user_id) do update set
    role = case
      when public.workspace_members.role = 'admin' then 'admin'
      else excluded.role
    end;

  update public.workspace_invites
    set accepted_at = now(), accepted_by = auth.uid()
    where id = invite.id;

  return query select invite.workspace_id, invite.role;
end;
$$;

revoke all on function public.accept_workspace_invite(text) from public, anon;
grant execute on function public.accept_workspace_invite(text) to authenticated;
