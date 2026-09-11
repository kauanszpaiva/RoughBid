import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const migrationUrl = new URL('../migrations/20260911173000_plan_reading_ground_truth_reviews.sql', import.meta.url);
const migration = existsSync(migrationUrl) ? readFileSync(migrationUrl, 'utf8') : '';

test('ground-truth review migration exists and review history is tenant scoped', () => {
  assert.equal(existsSync(migrationUrl), true, 'ground-truth review migration must exist');
  assert.match(migration, /create table public\.plan_reading_finding_reviews/);
  assert.match(migration, /private\.has_workspace_access\(workspace_id\)/);
  assert.match(migration, /private\.has_product_access\(\)/);
  assert.doesNotMatch(migration, /grant (insert|update|delete|all) on table public\.plan_reading_finding_reviews to authenticated/i);
});

test('review history keeps the model prediction and a separate canonical target', () => {
  assert.match(migration, /original_prediction jsonb not null/);
  assert.match(migration, /canonical_target jsonb/);
  assert.match(migration, /model text not null/);
  assert.match(migration, /action text not null[\s\S]*accepted[\s\S]*rejected[\s\S]*corrected/);
  assert.match(migration, /insert into public\.plan_reading_finding_reviews/);
});

test('review RPC restricts corrections to approved fields and validates corrected targets', () => {
  assert.match(migration, /array\['finding_type','label','value_text','quantity','unit','geometry'\]/);
  assert.match(migration, /correction contains unsupported fields/);
  assert.match(migration, /corrected review requires at least one correction field/);
  assert.match(migration, /finding_type must be a supported value/);
  assert.match(migration, /quantity must be numeric or null/);
  assert.match(migration, /geometry must be an object/);
});

test('review RPC is role-gated, locks the finding, and keeps legacy status compatible', () => {
  assert.match(migration, /private\.has_workspace_role\(target_workspace, array\['admin', 'estimator'\]\)/);
  assert.match(migration, /for update/);
  assert.match(migration, /when p_action = 'rejected' then 'rejected'/);
  assert.match(migration, /else 'accepted'/);
  assert.match(migration, /security definer/);
});

test('review ledger is QA-only by default and does not claim training permission', () => {
  assert.match(migration, /training_eligible boolean not null default false/);
  assert.match(migration, /check \(training_eligible = false\)/);
  assert.match(migration, /does not grant model-training rights/i);
});

test('legacy accept/reject RPC now records review history without breaking its return contract', () => {
  assert.match(migration, /create or replace function public\.set_plan_reading_finding_status/);
  assert.match(migration, /perform public\.review_plan_reading_finding\(finding_id, new_status, null\)/);
  assert.match(migration, /returns setof public\.plan_reading_findings/);
  assert.match(migration, /set status = 'needs_review'/);
});
