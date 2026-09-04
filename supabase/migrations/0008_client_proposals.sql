-- Public client-view links for finalized estimates.
-- Tokens are stored only as hashes. Anonymous users never receive direct table
-- grants; public access must go through narrowly scoped SECURITY DEFINER RPCs.

create table if not exists public.client_proposals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  estimate_id uuid not null references public.estimates(id) on delete restrict,
  token_hash text not null unique,
  title text not null,
  client_name text not null,
  client_email text,
  total_amount numeric(14, 2) not null check (total_amount >= 0),
  status text not null default 'sent' check (status in ('draft', 'sent', 'viewed', 'signed', 'expired', 'revoked')),
  expires_at timestamptz not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  first_viewed_at timestamptz,
  signed_at timestamptz,
  signature_name text,
  signature_ip_hash text,
  signature_user_agent text
);

create index if not exists client_proposals_workspace_idx
  on public.client_proposals(workspace_id, created_at desc);
create index if not exists client_proposals_project_idx
  on public.client_proposals(project_id, created_at desc);
create index if not exists client_proposals_status_idx
  on public.client_proposals(workspace_id, status, created_at desc);

create table if not exists public.client_proposal_events (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.client_proposals(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  event_type text not null check (event_type in ('opened', 'downloaded', 'signed', 'email_sent')),
  event_metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists client_proposal_events_proposal_idx
  on public.client_proposal_events(proposal_id, occurred_at desc);

alter table public.client_proposals enable row level security;
alter table public.client_proposal_events enable row level security;

create policy client_proposals_select_workspace on public.client_proposals
  for select to authenticated
  using (private.has_workspace_access(workspace_id));
create policy client_proposals_insert_estimator on public.client_proposals
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and private.has_workspace_role(workspace_id, array['admin','estimator'])
    and private.has_product_access()
  );
create policy client_proposals_update_estimator on public.client_proposals
  for update to authenticated
  using (private.has_workspace_role(workspace_id, array['admin','estimator']))
  with check (private.has_workspace_role(workspace_id, array['admin','estimator']));

create policy client_proposal_events_select_workspace on public.client_proposal_events
  for select to authenticated
  using (private.has_workspace_access(workspace_id));

revoke all on public.client_proposals from anon;
revoke all on public.client_proposal_events from anon;

create or replace function public.track_client_proposal_open(
  proposal_token_hash text,
  event_metadata jsonb default '{}'::jsonb
) returns table(proposal_id uuid, proposal_status text)
language plpgsql
security definer
set search_path = public, private
as $$
declare
  proposal record;
begin
  select * into proposal
  from public.client_proposals
  where token_hash = proposal_token_hash
    and status in ('sent', 'viewed')
    and expires_at > now()
  limit 1;

  if proposal.id is null then
    return;
  end if;

  update public.client_proposals
  set status = case when status = 'sent' then 'viewed' else status end,
      first_viewed_at = coalesce(first_viewed_at, now())
  where id = proposal.id;

  insert into public.client_proposal_events(proposal_id, workspace_id, event_type, event_metadata)
  values (proposal.id, proposal.workspace_id, 'opened', coalesce(event_metadata, '{}'::jsonb));

  proposal_id := proposal.id;
  proposal_status := 'viewed';
  return next;
end;
$$;

revoke all on function public.track_client_proposal_open(text, jsonb) from public, authenticated, anon;
grant execute on function public.track_client_proposal_open(text, jsonb) to anon, authenticated;

comment on table public.client_proposals is
  'Public client-view proposal links. Public tokens are hashed; anonymous access is RPC/API-scoped.';
comment on table public.client_proposal_events is
  'Open/download/sign events for proposal notification and audit workflows.';
