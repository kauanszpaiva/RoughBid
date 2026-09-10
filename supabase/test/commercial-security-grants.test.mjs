import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const internal = [
  'access_grant_tokens', 'auth_magic_link_attempts', 'auth_magic_link_rate_state',
  'billing_checkout_attempts', 'billing_subscription_sync', 'marketplace_checkout_attempts',
  'pilot_cohorts', 'pilot_email_events', 'pilot_enrollments', 'pilot_file_creations',
  'pilot_invitations', 'pilot_notification_outbox', 'pilot_project_creations',
  'pilot_reading_reservations', 'project_payment_events', 'project_reading_quotes',
  'provider_spend_policy', 'provider_spend_reservations', 'stripe_events', 'stripe_price_mappings',
];
const readable = [
  'billing_accounts', 'billing_customers', 'credit_grants', 'credit_ledger_entries',
  'project_entitlements', 'api_usage_events', 'marketplace_entitlements',
  'marketplace_purchases', 'sensitive_data_events', 'audit_events',
];

test('commercial ledgers expose only intended authenticated reads', async () => {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role;');
    for (const table of [...internal, ...readable]) {
      await db.exec(`create table ${table}(id integer); grant all on ${table} to anon,authenticated;`);
    }
    await db.exec(readFileSync(new URL('../migrations/0042_minimize_commercial_table_grants.sql', import.meta.url), 'utf8'));
    await db.exec('set role authenticated');
    for (const table of internal) {
      await assert.rejects(db.query(`select * from ${table}`), /permission denied/i, table);
      await assert.rejects(db.query(`insert into ${table} values(1)`), /permission denied/i, table);
    }
    for (const table of readable) {
      assert.deepEqual((await db.query(`select * from ${table}`)).rows, [], table);
      await assert.rejects(db.query(`insert into ${table} values(1)`), /permission denied/i, table);
    }
  } finally {
    await db.close();
  }
});
