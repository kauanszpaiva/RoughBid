-- Supabase default table grants are broader than the commercial API needs.
-- RLS remains the row boundary, but browser roles should not retain unused
-- INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER privileges on ledgers.
revoke all on table
  public.access_grant_tokens,
  public.auth_magic_link_attempts,
  public.auth_magic_link_rate_state,
  public.billing_checkout_attempts,
  public.billing_subscription_sync,
  public.marketplace_checkout_attempts,
  public.pilot_cohorts,
  public.pilot_email_events,
  public.pilot_enrollments,
  public.pilot_file_creations,
  public.pilot_invitations,
  public.pilot_notification_outbox,
  public.pilot_project_creations,
  public.pilot_reading_reservations,
  public.project_payment_events,
  public.project_reading_quotes,
  public.provider_spend_policy,
  public.provider_spend_reservations,
  public.stripe_events,
  public.stripe_price_mappings
from public, anon, authenticated;

grant all on table
  public.access_grant_tokens,
  public.auth_magic_link_attempts,
  public.auth_magic_link_rate_state,
  public.billing_checkout_attempts,
  public.billing_subscription_sync,
  public.marketplace_checkout_attempts,
  public.pilot_cohorts,
  public.pilot_email_events,
  public.pilot_enrollments,
  public.pilot_file_creations,
  public.pilot_invitations,
  public.pilot_notification_outbox,
  public.pilot_project_creations,
  public.pilot_reading_reservations,
  public.project_payment_events,
  public.project_reading_quotes,
  public.provider_spend_policy,
  public.provider_spend_reservations,
  public.stripe_events,
  public.stripe_price_mappings
to service_role;

-- These tables have intentional authenticated SELECT policies. Preserve that
-- read path while removing every direct browser mutation privilege.
revoke all on table
  public.billing_accounts,
  public.billing_customers,
  public.credit_grants,
  public.credit_ledger_entries,
  public.project_entitlements,
  public.api_usage_events,
  public.marketplace_entitlements,
  public.marketplace_purchases,
  public.sensitive_data_events,
  public.audit_events
from public, anon, authenticated;

grant select on table
  public.billing_accounts,
  public.billing_customers,
  public.credit_grants,
  public.credit_ledger_entries,
  public.project_entitlements,
  public.api_usage_events,
  public.marketplace_entitlements,
  public.marketplace_purchases,
  public.sensitive_data_events,
  public.audit_events
to authenticated;

grant all on table
  public.billing_accounts,
  public.billing_customers,
  public.credit_grants,
  public.credit_ledger_entries,
  public.project_entitlements,
  public.api_usage_events,
  public.marketplace_entitlements,
  public.marketplace_purchases,
  public.sensitive_data_events,
  public.audit_events
to service_role;
