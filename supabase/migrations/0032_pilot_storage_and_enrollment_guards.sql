-- Sponsored files use the bounded Vercel upload path. Browser users must not
-- bypass its quotas by creating arbitrary objects in the legacy Supabase bucket.
-- Preserve cleanup of existing objects: deleted files never refund pilot quotas.
create function private.can_delete_plan_object(object_name text)
returns boolean language plpgsql stable security definer set search_path=public,pg_temp as $$
declare target_workspace uuid;
begin
  if split_part(object_name,'/',1) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  target_workspace := split_part(object_name,'/',1)::uuid;
  return private.has_workspace_role(target_workspace,array['admin','estimator']) and private.has_product_access();
end;
$$;
revoke all on function private.can_delete_plan_object(text) from public,anon;
grant execute on function private.can_delete_plan_object(text) to authenticated;
drop policy if exists plan_files_storage_delete_rbac on storage.objects;
create policy plan_files_storage_delete_rbac on storage.objects for delete to authenticated
  using (bucket_id='plan-files' and private.can_delete_plan_object(name));

create or replace function private.can_write_plan_object(object_name text)
returns boolean language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  if exists(
    select 1 from public.pilot_enrollments e join public.pilot_cohorts c on c.id=e.cohort_id
    where e.user_id=auth.uid() and e.revoked_at is null and e.starts_at<=now() and e.expires_at>now() and c.enabled
  ) and not exists(select 1 from public.profiles where id=auth.uid() and is_platform_admin) then return false; end if;
  return private.can_delete_plan_object(object_name);
end;
$$;
revoke all on function private.can_write_plan_object(text) from public,anon;
grant execute on function private.can_write_plan_object(text) to authenticated;

-- A sponsored invitation must not overlap an existing renewal or an open
-- membership Checkout. No Stripe subscription or checkout is canceled here.
create or replace function public.redeem_pilot_invitation(p_token_digest text,p_workspace_name text default 'My Workspace')
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare i public.pilot_invitations; e public.pilot_enrollments; c public.pilot_cohorts; recipient_email text; workspace uuid; started timestamptz;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_token_digest is null or p_token_digest !~ '^[a-f0-9]{64}$' then raise exception 'Invalid invitation token'; end if;
  if p_workspace_name is null or char_length(btrim(p_workspace_name)) not between 1 and 120 then raise exception 'Invalid workspace name'; end if;
  select * into i from public.pilot_invitations where token_hash=p_token_digest;
  if not found then raise exception 'Invitation is invalid, expired, or revoked'; end if;
  select * into c from public.pilot_cohorts where id=i.cohort_id for update;
  select * into i from public.pilot_invitations where id=i.id for update;
  select lower(email) into recipient_email from auth.users where id=auth.uid() and email_confirmed_at is not null;
  if recipient_email is null or recipient_email <> i.email then raise exception 'Invitation requires its verified recipient email'; end if;
  if i.revoked_at is not null then raise exception 'Invitation is invalid, expired, or revoked'; end if;
  if i.accepted_at is not null then
    if i.accepted_by <> auth.uid() then raise exception 'Invitation already used'; end if;
    select * into e from public.pilot_enrollments where invitation_id=i.id;
    return jsonb_build_object('workspace_id',e.workspace_id,'starts_at',e.starts_at,'expires_at',e.expires_at,'preset',e.preset,'reused',true);
  end if;
  if not c.enabled or i.expires_at<=now() then raise exception 'Invitation is invalid, expired, or revoked'; end if;
  if exists(select 1 from public.pilot_enrollments where user_id=auth.uid()) then raise exception 'One pilot enrollment per user'; end if;
  if (select count(*) from public.pilot_enrollments where cohort_id=c.id)>=c.capacity then raise exception 'Pilot cohort is full'; end if;
  if exists(select 1 from public.profiles where id=auth.uid() and is_platform_admin) then raise exception 'Platform owner already has complimentary access'; end if;
  -- claim_billing_checkout uses the same lock. The check and enrollment cannot
  -- race a new Checkout claim, including one whose Stripe session is in flight.
  perform 1 from public.profiles where id=auth.uid() for update;
  if not found then raise exception 'Account profile unavailable'; end if;
  if exists(select 1 from public.billing_customers where user_id=auth.uid() and subscription_status not in ('canceled','incomplete_expired')) then
    raise exception 'Manage and end the existing membership before accepting sponsored access';
  end if;
  if exists(select 1 from public.billing_checkout_attempts where user_id=auth.uid() and expires_at>now()) then
    raise exception 'An existing membership checkout is still open; let it expire before accepting sponsored access';
  end if;
  started := now();
  insert into public.workspaces(name,created_by) values(btrim(p_workspace_name),auth.uid()) returning id into workspace;
  insert into public.pilot_enrollments(user_id,cohort_id,invitation_id,workspace_id,preset,starts_at,expires_at)
    values(auth.uid(),c.id,i.id,workspace,i.preset,started,started+case i.preset when 'sample1' then interval '7 days' when 'month1' then interval '30 days' else interval '60 days' end) returning * into e;
  insert into public.entitlements(user_id,kind,source,external_ref,starts_at,expires_at)
    values(auth.uid(),'access_grant','limited_pilot',i.id::text,e.starts_at,e.expires_at);
  update public.pilot_invitations set accepted_at=started,accepted_by=auth.uid() where id=i.id;
  return jsonb_build_object('workspace_id',workspace,'starts_at',e.starts_at,'expires_at',e.expires_at,'preset',e.preset,'reused',false);
end;
$$;
revoke all on function public.redeem_pilot_invitation(text,text) from public,anon;
grant execute on function public.redeem_pilot_invitation(text,text) to authenticated;
