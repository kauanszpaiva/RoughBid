-- Cover foreign keys added by the RB.AI human-review ledger.
-- These indexes reduce parent-row delete/update cost and keep the production
-- database advisor clean without changing authorization or application behavior.

create index if not exists plan_reading_finding_reviews_project_idx
  on public.plan_reading_finding_reviews(project_id);

create index if not exists plan_reading_finding_reviews_file_idx
  on public.plan_reading_finding_reviews(file_id);

create index if not exists plan_reading_finding_reviews_reviewer_idx
  on public.plan_reading_finding_reviews(reviewed_by)
  where reviewed_by is not null;
