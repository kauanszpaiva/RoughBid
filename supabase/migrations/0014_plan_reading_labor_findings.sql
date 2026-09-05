-- The AI plan reader now identifies labor/service scope (demolition, framing,
-- install labor, etc.) as its own finding, separate from the materials it
-- prices. Widen the finding_type check constraint to allow it.
alter table public.plan_reading_findings
  drop constraint plan_reading_findings_finding_type_check;

alter table public.plan_reading_findings
  add constraint plan_reading_findings_finding_type_check
  check (finding_type in ('measurement', 'symbol', 'room', 'scope_note', 'risk', 'question', 'material', 'labor'));
