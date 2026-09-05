-- Public proposal links backed by a client-safe snapshot.
-- This lets RoughBid share an estimate view before the local app has fully
-- migrated every estimate line into the normalized estimates tables.

alter table public.client_proposals
  alter column estimate_id drop not null,
  add column if not exists public_payload jsonb not null default '{}'::jsonb,
  add column if not exists last_viewed_at timestamptz;

create or replace function public.get_client_proposal(
  proposal_token_hash text,
  event_metadata jsonb default '{}'::jsonb
) returns table(
  proposal_id uuid,
  title text,
  client_name text,
  client_email text,
  total_amount numeric,
  status text,
  expires_at timestamptz,
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  signed_at timestamptz,
  signature_name text,
  public_payload jsonb,
  notification_email text,
  was_first_open boolean
)
language plpgsql
security definer
set search_path = public, private
as $$
declare
  proposal record;
begin
  select cp.*, au.email as owner_email into proposal
  from public.client_proposals cp
  left join auth.users au on au.id = cp.created_by
  where cp.token_hash = proposal_token_hash
    and cp.status in ('sent', 'viewed', 'signed')
    and cp.expires_at > now()
  limit 1;

  if proposal.id is null then
    return;
  end if;

  update public.client_proposals
  set status = case when public.client_proposals.status = 'sent' then 'viewed' else public.client_proposals.status end,
      first_viewed_at = coalesce(public.client_proposals.first_viewed_at, now()),
      last_viewed_at = now()
  where public.client_proposals.id = proposal.id;

  insert into public.client_proposal_events(proposal_id, workspace_id, event_type, event_metadata)
  values (proposal.id, proposal.workspace_id, 'opened', coalesce(event_metadata, '{}'::jsonb));

  proposal_id := proposal.id;
  title := proposal.title;
  client_name := proposal.client_name;
  client_email := proposal.client_email;
  total_amount := proposal.total_amount;
  status := case when proposal.status = 'sent' then 'viewed' else proposal.status end;
  expires_at := proposal.expires_at;
  first_viewed_at := coalesce(proposal.first_viewed_at, now());
  last_viewed_at := now();
  signed_at := proposal.signed_at;
  signature_name := proposal.signature_name;
  public_payload := proposal.public_payload;
  notification_email := proposal.owner_email;
  was_first_open := proposal.first_viewed_at is null;
  return next;
end;
$$;

create or replace function public.sign_client_proposal(
  proposal_token_hash text,
  signer_name text,
  event_metadata jsonb default '{}'::jsonb
) returns table(
  proposal_id uuid,
  proposal_title text,
  proposal_status text,
  signed_at timestamptz,
  signature_name text,
  notification_email text
)
language plpgsql
security definer
set search_path = public, private
as $$
declare
  proposal record;
  normalized_name text;
begin
  normalized_name := nullif(trim(signer_name), '');
  if normalized_name is null or char_length(normalized_name) > 160 then
    raise exception 'A signer name is required.';
  end if;

  select cp.*, au.email as owner_email into proposal
  from public.client_proposals cp
  left join auth.users au on au.id = cp.created_by
  where cp.token_hash = proposal_token_hash
    and cp.status in ('sent', 'viewed')
    and cp.expires_at > now()
  limit 1;

  if proposal.id is null then
    return;
  end if;

  update public.client_proposals
  set status = 'signed',
      signed_at = now(),
      signature_name = normalized_name,
      signature_ip_hash = nullif(event_metadata ->> 'ip_hash', ''),
      signature_user_agent = left(nullif(event_metadata ->> 'user_agent', ''), 500)
  where id = proposal.id;

  insert into public.client_proposal_events(proposal_id, workspace_id, event_type, event_metadata)
  values (proposal.id, proposal.workspace_id, 'signed', coalesce(event_metadata, '{}'::jsonb));

  proposal_id := proposal.id;
  proposal_title := proposal.title;
  proposal_status := 'signed';
  signed_at := now();
  signature_name := normalized_name;
  notification_email := proposal.owner_email;
  return next;
end;
$$;

revoke all on function public.get_client_proposal(text, jsonb) from public, authenticated, anon;
revoke all on function public.sign_client_proposal(text, text, jsonb) from public, authenticated, anon;
grant execute on function public.get_client_proposal(text, jsonb) to anon, authenticated;
grant execute on function public.sign_client_proposal(text, text, jsonb) to anon, authenticated;
