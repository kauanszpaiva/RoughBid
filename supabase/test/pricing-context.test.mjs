import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrationPath = resolve('supabase/migrations/0035_pricing_context.sql');

test('0035 defines a workspace-scoped pricing context and protected human resolution RPC', () => {
  assert.ok(existsSync(migrationPath), '0035_pricing_context.sql must exist before this contract can pass');
  const sql = readFileSync(migrationPath, 'utf8');

  assert.match(sql, /create table public\.project_pricing_contexts/i);
  assert.match(sql, /project_id uuid primary key references public\.projects\(id\) on delete cascade/i);
  assert.match(sql, /workspace_id uuid not null references public\.workspaces\(id\) on delete cascade/i);
  assert.match(sql, /project_address_text text/i);
  assert.match(sql, /plan_address jsonb/i);
  assert.match(sql, /pricing_address jsonb/i);
  assert.match(sql, /address_source text[\s\S]*'plan'[\s\S]*'project'[\s\S]*'confirmed_override'/i);
  assert.match(sql, /address_status text not null[\s\S]*'missing'[\s\S]*'clear'[\s\S]*'needs_resolution'[\s\S]*'resolved'/i);
  assert.match(sql, /plan_file_id uuid references public\.project_files\(id\) on delete set null/i);
  assert.match(sql, /plan_job_id uuid references public\.plan_reading_jobs\(id\) on delete set null/i);
  assert.match(sql, /resolved_by uuid references auth\.users\(id\) on delete set null/i);
  assert.match(sql, /resolved_at timestamptz/i);
  assert.match(sql, /unique \(workspace_id, project_id\)/i);

  assert.match(sql, /resolved_by is null and resolved_at is null[\s\S]*resolved_by is not null and resolved_at is not null/i);
  assert.match(sql, /address_status <> 'needs_resolution' or pricing_address is null/i);
  assert.match(sql, /address_status <> 'resolved'[\s\S]*pricing_address is not null[\s\S]*resolved_by is not null[\s\S]*resolved_at is not null/i);

  assert.match(sql, /alter table public\.project_pricing_contexts enable row level security/i);
  assert.match(sql, /create policy project_pricing_contexts_select_member[\s\S]*private\.has_workspace_role\(workspace_id, array\['admin','estimator','viewer'\]\)[\s\S]*private\.has_product_access\(\)/i);
  assert.match(sql, /revoke insert, update, delete on public\.project_pricing_contexts from authenticated, anon/i);
  assert.match(sql, /grant select on public\.project_pricing_contexts to authenticated/i);

  assert.match(sql, /create or replace function public\.resolve_project_pricing_address\(p_project_id uuid, p_choice text\)/i);
  assert.match(sql, /security definer/i);
  assert.match(sql, /auth\.uid\(\) is null/i);
  assert.match(sql, /p_choice not in \('plan', 'project'\)/i);
  assert.match(sql, /from public\.project_pricing_contexts[\s\S]*for update/i);
  assert.match(sql, /private\.has_workspace_role\(context_row\.workspace_id, array\['admin','estimator'\]\)/i);
  assert.match(sql, /private\.has_product_access\(\)/i);
  assert.match(sql, /p_choice = 'plan'[\s\S]*plan_address is null/i);
  assert.match(sql, /project_address_text is null/i);
  assert.match(sql, /address_source = 'confirmed_override'/i);
  assert.match(sql, /address_status = 'resolved'/i);
  assert.match(sql, /resolved_by = auth\.uid\(\)/i);
  assert.match(sql, /resolved_at = now\(\)/i);
  assert.match(sql, /revoke all on function public\.resolve_project_pricing_address\(uuid, text\) from public, anon/i);
  assert.match(sql, /grant execute on function public\.resolve_project_pricing_address\(uuid, text\) to authenticated/i);
});
