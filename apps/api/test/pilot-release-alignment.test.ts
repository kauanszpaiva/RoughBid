import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PILOT_MODEL, PILOT_RESERVATION_CENTS } from '../src/ai-plan/pilot-reader.ts';

const migration = readFileSync(
  new URL('../../../supabase/migrations/0034_pilot_budget_and_model_alignment.sql', import.meta.url),
  'utf8',
);
const capacityMigration = readFileSync(
  new URL('../../../supabase/migrations/20260919160714_pilot_capacity_35.sql', import.meta.url),
  'utf8',
);
const pilotInviteOnlyMigration = readFileSync(
  new URL('../../../supabase/migrations/20260919162447_pilot_invite_only_access.sql', import.meta.url),
  'utf8',
);

test('pilot release is pinned to the production-verified provider model', () => {
  assert.equal(PILOT_MODEL, 'gemini-3.8-flash');
  assert.match(migration, /p_model is distinct from 'gemini-3\.8-flash'/);
  assert.doesNotMatch(migration, /gemini-2\.5-flash/);
});

test('pilot release enforces the approved aggregate cohort ceiling before provider work', () => {
  assert.equal(PILOT_RESERVATION_CENTS, 25);
  assert.match(migration, /reserved_cents > 10000/);
  assert.match(migration, /budget_cents = 10000/);
  assert.match(migration, /budget_cents between 0 and 10000/);
  assert.match(migration, /c\.reserved_cents\+25>c\.budget_cents/);
});

test('pilot release removes direct RPC execution from the workspace-owner trigger function', () => {
  assert.match(migration, /revoke execute on function public\.add_workspace_owner_membership\(\)/);
  assert.match(migration, /from public,anon,authenticated/);
});


test('pilot release aligns the founding cohort to the approved 35-user ceiling', () => {
  assert.match(capacityMigration, /set capacity = 35/i);
  assert.match(capacityMigration, /alter column capacity set default 35/i);
  assert.match(capacityMigration, /capacity between 1 and 35/i);
  assert.match(capacityMigration, /Pilot cohort is full \(% recipients maximum\)/);
  assert.doesNotMatch(capacityMigration, /25 recipients maximum/);
});


test('limited pilot release is invite-only and becomes read-only after access ends', () => {
  assert.match(pilotInviteOnlyMigration, /authorize_roughbid_magic_link/);
  assert.match(pilotInviteOnlyMigration, /pilot_workspace_write_allowed/);
  assert.match(pilotInviteOnlyMigration, /private\.can_create_workspace\(\)/);
  assert.match(pilotInviteOnlyMigration, /is_platform_admin/);
  assert.match(pilotInviteOnlyMigration, /self-service workspace creation is closed/i);
  assert.match(pilotInviteOnlyMigration, /created_by = auth\.uid\(\)[\s\S]*private\.can_create_workspace\(\)/);
  assert.match(pilotInviteOnlyMigration, /'viewer' = any\(allowed_roles\)[\s\S]*pilot_workspace_write_allowed/);
  assert.match(pilotInviteOnlyMigration, /grant execute on function public\.authorize_roughbid_magic_link\(text,text,text\)[\s\S]*service_role/);
});
