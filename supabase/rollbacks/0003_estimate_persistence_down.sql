drop trigger if exists estimates_protect_lifecycle on public.estimates;
drop function if exists public.protect_estimate_lifecycle();

alter table public.estimates
  drop constraint if exists estimates_finalized_status_consistent,
  drop column if exists finalized_at,
  drop column if exists gross_margin_percent,
  drop column if exists markup_amount,
  drop column if exists cost_with_overhead;
