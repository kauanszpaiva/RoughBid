import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('tenant isolation migration binds project-scoped records to the same workspace', async () => {
  const sql = (await readFile(new URL('../migrations/0011_tenant_project_isolation.sql', import.meta.url), 'utf8')).toLowerCase();
  for (const required of [
    'estimates_id_workspace_project_unique',
    'project_files_id_workspace_project_unique',
    'plan_reading_jobs_id_workspace_project_file_unique',
    'estimates_project_workspace_fkey',
    'estimate_audit_log_estimate_workspace_project_fkey',
    'plan_reading_jobs_project_workspace_fkey',
    'plan_reading_jobs_file_workspace_project_fkey',
    'plan_reading_findings_job_workspace_project_file_fkey',
    'client_proposals_project_workspace_fkey',
    'client_proposals_estimate_workspace_project_fkey',
    'client_proposal_events_proposal_workspace_fkey',
  ]) {
    assert.ok(sql.includes(required), `missing tenant isolation primitive: ${required}`);
  }
});

test('tenant isolation migration does not weaken RLS or expose anonymous tables', async () => {
  const sql = (await readFile(new URL('../migrations/0011_tenant_project_isolation.sql', import.meta.url), 'utf8')).toLowerCase();
  assert.equal(sql.includes('disable row level security'), false);
  assert.equal(sql.includes('grant all'), false);
  assert.equal(sql.includes(' to anon'), false);
  assert.equal(sql.includes('security definer'), false);
});
