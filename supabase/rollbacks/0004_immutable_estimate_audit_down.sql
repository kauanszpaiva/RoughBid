drop trigger if exists estimates_record_immutable_audit on public.estimates;
drop function if exists private.record_estimate_audit();

drop trigger if exists estimate_audit_log_reject_mutation on public.estimate_audit_log;
drop function if exists private.reject_estimate_audit_mutation();
drop table if exists public.estimate_audit_log;
