-- Incident containment after 0018 has committed. Run only in the approved
-- target environment, after disabling new requests in the application.
-- Preserve consent, labor findings, paid quotes and payment history.
-- Already-running model requests cannot be canceled by a database grant change.
begin;
revoke all on function public.reserve_project_reading(uuid,uuid,uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;
-- Cover the optional 0019 pilot entry point if present in the deployed schema.
do $$ begin
  if to_regprocedure('public.reserve_pilot_project_reading(uuid,uuid,uuid,uuid,uuid,text)') is not null then
    revoke all on function public.reserve_pilot_project_reading(uuid,uuid,uuid,uuid,uuid,text)
      from public, anon, authenticated, service_role;
  end if;
end $$;
revoke all on function public.set_plan_reading_finding_status(uuid,text)
  from public, anon, authenticated;
commit;
