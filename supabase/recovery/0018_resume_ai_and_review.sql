-- Do not run automatically. Only resume after the incident is resolved, the
-- complete target-SHA gate passes, and the target environment is approved.
-- This restores exactly the narrowly scoped application grants paused above.
begin;
revoke all on function public.reserve_project_reading(uuid,uuid,uuid,uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.reserve_project_reading(uuid,uuid,uuid,uuid,uuid,text)
  to service_role;
do $$ begin
  if to_regprocedure('public.reserve_pilot_project_reading(uuid,uuid,uuid,uuid,uuid,text)') is not null then
    revoke all on function public.reserve_pilot_project_reading(uuid,uuid,uuid,uuid,uuid,text)
      from public, anon, authenticated;
    grant execute on function public.reserve_pilot_project_reading(uuid,uuid,uuid,uuid,uuid,text)
      to service_role;
  end if;
end $$;
revoke all on function public.set_plan_reading_finding_status(uuid,text)
  from public, anon;
grant execute on function public.set_plan_reading_finding_status(uuid,text)
  to authenticated;
commit;
