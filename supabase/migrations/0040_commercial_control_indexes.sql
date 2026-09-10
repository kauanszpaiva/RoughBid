-- Cover new operational foreign keys without changing existing constraints.
create index if not exists provider_spend_job_idx on public.provider_spend_reservations(job_id);
create index if not exists provider_spend_workspace_idx on public.provider_spend_reservations(workspace_id);
create index if not exists provider_spend_user_idx on public.provider_spend_reservations(user_id);
create index if not exists marketplace_checkout_workspace_idx on public.marketplace_checkout_attempts(workspace_id);
