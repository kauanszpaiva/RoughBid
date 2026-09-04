# Supabase integration status

- Project: RoughBid
- Region: `us-east-1`
- Project reference: `piasgpciojstjalaqazu`
- API URL: `https://piasgpciojstjalaqazu.supabase.co`
- Migrations applied: `foundation`, `security_hardening`, `estimate_persistence`,
  `project_file_integrity`, `stripe_event_processing`, `auth_rbac_class_pass`,
  `document_processing`, `immutable_estimate_audit` — i.e. everything under
  `supabase/migrations/` as of this writing. Keep this list in sync: run
  `mcp__Supabase__list_migrations` (or `supabase migration list`) before
  assuming the live schema matches the repo.
- Security advisor findings after hardening: zero unexpected. Two INFO/WARN
  findings are by design — see the comments in
  `supabase/migrations/0004_auth_rbac_class_pass.sql` (`class_pass_tokens` has
  no policies on purpose; `redeem_class_pass` is meant to be callable by
  signed-in users).
- Plan PDFs: private `plan-files` bucket, PDF only, 50 MB object limit.
- Product access: entitlement based (`class_pass`, `subscription`, `admin`).
