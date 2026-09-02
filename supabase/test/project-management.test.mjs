import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('project file migration binds metadata and storage paths to the same workspace project', async () => {
  const sql = (await readFile(new URL('../migrations/0003_project_file_integrity.sql', import.meta.url), 'utf8')).toLowerCase();
  for (const requirement of [
    'foreign key (project_id, workspace_id)',
    'references public.projects(id, workspace_id)',
    'private.has_workspace_access(workspace_uuid)',
    'private.has_product_access()',
    'p.id = project_uuid and p.workspace_id = workspace_uuid',
  ]) assert.match(sql, new RegExp(requirement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
