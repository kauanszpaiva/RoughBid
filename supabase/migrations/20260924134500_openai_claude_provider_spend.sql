-- Approve the two remaining first-class plan readers for the company AI spend
-- breaker. 20260919142500_low_cost_ai_provider_spend.sql whitelisted only the
-- low-cost vision providers, so a configured OpenAI or Claude reader was
-- rejected by the database with 'Provider spend identity is invalid' before a
-- single provider request could be made: plan reading could never run on them.
-- No secret, endpoint or price is stored in Postgres; activation stays behind
-- server-only environment flags (OPENAI_PLAN_READING_ENABLED,
-- CLAUDE_PLAN_READING_ENABLED) and the shared company cap below still applies
-- to every provider, so one exhausted budget stops all of them.
create or replace function public.reserve_provider_spend(
  p_event_id uuid,
  p_job_id uuid,
  p_workspace_id uuid,
  p_user_id uuid,
  p_provider text,
  p_model text
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  policy public.provider_spend_policy;
  used numeric(12,6);
  reservation public.provider_spend_reservations;
begin
  if p_provider not in ('gemini','deepseek','kimi','openai','claude') or btrim(coalesce(p_model,'')) = '' then
    raise exception 'Provider spend identity is invalid';
  end if;

  select * into policy from public.provider_spend_policy where singleton for update;
  if not found or not policy.enabled then raise exception 'Company AI spend is disabled'; end if;

  select * into reservation from public.provider_spend_reservations where event_id=p_event_id;
  if found then
    if reservation.job_id<>p_job_id or reservation.workspace_id<>p_workspace_id
       or reservation.user_id is distinct from p_user_id or reservation.provider<>p_provider or reservation.model<>p_model then
      raise exception 'Provider spend reservation identity mismatch';
    end if;
    return to_jsonb(reservation);
  end if;

  perform 1 from public.plan_reading_jobs
  where id=p_job_id and workspace_id=p_workspace_id and requested_by=p_user_id
  for share;
  if not found then raise exception 'Provider spend job is not authorized'; end if;

  select coalesce(sum(case
    when status='captured' and telemetry_known then estimated_cost_usd
    else reserved_usd end),0)
  into used
  from public.provider_spend_reservations
  where created_at > now()-policy.rolling_window;

  if used + policy.call_reservation_usd > policy.spend_cap_usd then
    raise exception 'Company AI spend limit reached';
  end if;

  insert into public.provider_spend_reservations(
    event_id,job_id,workspace_id,user_id,provider,model,reserved_usd
  ) values(
    p_event_id,p_job_id,p_workspace_id,p_user_id,p_provider,p_model,policy.call_reservation_usd
  ) returning * into reservation;
  return to_jsonb(reservation);
end
$$;

comment on function public.reserve_provider_spend(uuid,uuid,uuid,uuid,text,text)
  is 'Service-only company AI spend breaker. Approved providers: Gemini, DeepSeek, Kimi, OpenAI, Claude.';