-- Durable expiry notices and authenticated provider delivery events. No message
-- is sent by migration; the protected scheduler claims bounded outbox batches.
alter table public.pilot_invitations add column email_delivery_status text;
alter table public.pilot_invitations add column email_delivery_at timestamptz;

create table public.pilot_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.pilot_enrollments(user_id) on delete restrict,
  kind text not null check(kind in ('expires_7d','expires_1d','expired')),
  email text not null,
  expires_at timestamptz not null,
  status text not null default 'pending' check(status in ('pending','processing','sent','failed','needs_review','suppressed')),
  attempts integer not null default 0 check(attempts between 0 and 5),
  lease_id uuid,
  lease_expires_at timestamptz,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  provider_message_id text unique,
  provider_delivery_status text,
  provider_delivery_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique(user_id,kind,expires_at)
);
create table public.pilot_email_events (
  event_id text primary key,
  message_id text not null,
  event_type text not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now()
);
alter table public.pilot_notification_outbox enable row level security;
alter table public.pilot_email_events enable row level security;
revoke all on public.pilot_notification_outbox,public.pilot_email_events from anon,authenticated;

create function public.claim_pilot_notifications(p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare claimed jsonb;
begin
  if p_limit < 1 or p_limit > 25 then raise exception 'Invalid notification batch size'; end if;
  insert into public.pilot_notification_outbox(user_id,kind,email,expires_at)
  select e.user_id,n.kind,u.email,e.expires_at
  from public.pilot_enrollments e
  join auth.users u on u.id=e.user_id
  join public.pilot_invitations i on i.id=e.invitation_id
  cross join lateral (values ('expires_7d'::text),('expires_1d'::text),('expired'::text)) n(kind)
  where e.revoked_at is null and i.revoked_at is null and u.email_confirmed_at is not null
    and lower(u.email)=i.email
    and coalesce(i.email_delivery_status,'') not in ('email.bounced','email.complained','email.failed','email.suppressed')
    and not exists(select 1 from public.pilot_notification_outbox previous where previous.user_id=e.user_id and previous.provider_delivery_status in ('email.bounced','email.complained','email.failed','email.suppressed'))
    and case n.kind
      when 'expires_7d' then e.preset <> 'sample1' and e.expires_at > now()+interval '1 day' and e.expires_at <= now()+interval '7 days'
      when 'expires_1d' then e.expires_at > now() and e.expires_at <= now()+interval '1 day'
      else e.expires_at <= now() and e.expires_at > now()-interval '7 days' end
  on conflict(user_id,kind,expires_at) do nothing;

  -- Revocation or changed addresses cancel unsent notices. Do not send stale
  -- pre-expiry notices after the access period has already ended.
  update public.pilot_notification_outbox o set status='suppressed',lease_id=null,lease_expires_at=null
  from public.pilot_enrollments e,public.pilot_invitations i,auth.users u
  where e.user_id=o.user_id and i.id=e.invitation_id and u.id=e.user_id
    and o.status in ('pending','failed','processing')
    and (e.revoked_at is not null or i.revoked_at is not null or lower(u.email)<>o.email
      or coalesce(i.email_delivery_status,'') in ('email.bounced','email.complained','email.failed','email.suppressed')
      or exists(select 1 from public.pilot_notification_outbox previous where previous.user_id=e.user_id and previous.provider_delivery_status in ('email.bounced','email.complained','email.failed','email.suppressed'))
      or (o.kind<>'expired' and o.expires_at<=now()));

  -- A provider may have accepted a timed-out request. Beyond its idempotency
  -- retention window, stop for review instead of risking a duplicate notice.
  update public.pilot_notification_outbox set status='needs_review',last_error='Delivery outcome needs review before another provider attempt',lease_id=null,lease_expires_at=null
    where status in ('failed','processing') and (attempts>=5 or first_attempt_at<now()-interval '23 hours')
      and (lease_expires_at is null or lease_expires_at<=now());

  with due as (
    select id from public.pilot_notification_outbox
    where ((status in ('pending','failed') and next_attempt_at<=now()) or (status='processing' and lease_expires_at<=now()))
      and attempts<5
    order by created_at for update skip locked limit p_limit
  ), rows as (
    update public.pilot_notification_outbox o set status='processing',attempts=attempts+1,
      lease_id=gen_random_uuid(),lease_expires_at=now()+interval '10 minutes',first_attempt_at=coalesce(first_attempt_at,now())
    from due where o.id=due.id returning o.*
  ) select coalesce(jsonb_agg(to_jsonb(rows)),'[]'::jsonb) into claimed from rows;
  return claimed;
end;
$$;

create function public.finish_pilot_notification(p_notification_id uuid,p_lease_id uuid,p_message_id text,p_error text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare o public.pilot_notification_outbox;
begin
  update public.pilot_notification_outbox set
    status=case when p_error is null and nullif(p_message_id,'') is not null then 'sent' else 'failed' end,
    provider_message_id=coalesce(nullif(p_message_id,''),provider_message_id),last_error=left(p_error,500),
    sent_at=case when p_error is null and nullif(p_message_id,'') is not null then now() else sent_at end,
    lease_id=null,lease_expires_at=null,next_attempt_at=now()+interval '15 minutes'
  where id=p_notification_id and status='processing' and lease_id=p_lease_id
  returning * into o;
  if not found then raise exception 'Notification lease is no longer active'; end if;
  update public.pilot_notification_outbox n set provider_delivery_status=e.event_type,provider_delivery_at=e.occurred_at
  from (select event_type,occurred_at from public.pilot_email_events where message_id=p_message_id order by occurred_at desc limit 1) e
  where n.id=o.id returning n.* into o;
  if not found then select * into o from public.pilot_notification_outbox where id=p_notification_id; end if;
  return to_jsonb(o);
end;
$$;

create function public.record_pilot_email_event(p_event_id text,p_message_id text,p_event_type text,p_occurred_at timestamptz)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare inserted integer;
begin
  if p_event_id is null or char_length(p_event_id)>200 or p_message_id is null or char_length(p_message_id)>200 then raise exception 'Invalid email event'; end if;
  if p_event_type not in ('email.sent','email.delivered','email.delivery_delayed','email.bounced','email.complained','email.failed','email.suppressed') then raise exception 'Unsupported email event'; end if;
  insert into public.pilot_email_events(event_id,message_id,event_type,occurred_at) values(p_event_id,p_message_id,p_event_type,p_occurred_at) on conflict do nothing;
  get diagnostics inserted=row_count;
  if inserted=0 then return jsonb_build_object('duplicate',true); end if;
  update public.pilot_invitations set email_delivery_status=p_event_type,email_delivery_at=p_occurred_at
    where email_message_id=p_message_id and (email_delivery_at is null or email_delivery_at<=p_occurred_at);
  update public.pilot_notification_outbox set provider_delivery_status=p_event_type,provider_delivery_at=p_occurred_at
    where provider_message_id=p_message_id and (provider_delivery_at is null or provider_delivery_at<=p_occurred_at);
  if p_event_type in ('email.bounced','email.complained','email.failed','email.suppressed') then
    update public.pilot_invitations i set email_delivery_status=p_event_type,email_delivery_at=p_occurred_at
    from public.pilot_enrollments e,public.pilot_notification_outbox o
    where e.invitation_id=i.id and o.user_id=e.user_id and o.provider_message_id=p_message_id
      and (i.email_delivery_at is null or i.email_delivery_at<=p_occurred_at);
  end if;
  return jsonb_build_object('duplicate',false);
end;
$$;

-- Webhooks may arrive before the send-response message id is persisted.
create function public.sync_pilot_invitation_delivery()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare event public.pilot_email_events;
begin
  select * into event from public.pilot_email_events where message_id=new.email_message_id order by occurred_at desc limit 1;
  if found and (new.email_delivery_at is null or new.email_delivery_at<=event.occurred_at) then
    new.email_delivery_status:=event.event_type; new.email_delivery_at:=event.occurred_at;
  end if;
  return new;
end;
$$;
create trigger pilot_invitation_delivery_before_update before update of email_message_id on public.pilot_invitations for each row execute function public.sync_pilot_invitation_delivery();
revoke all on function public.sync_pilot_invitation_delivery() from public,anon,authenticated;

revoke all on function public.claim_pilot_notifications(integer),public.finish_pilot_notification(uuid,uuid,text,text),public.record_pilot_email_event(text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.claim_pilot_notifications(integer),public.finish_pilot_notification(uuid,uuid,text,text),public.record_pilot_email_event(text,text,text,timestamptz) to service_role;
