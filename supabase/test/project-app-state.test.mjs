import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('project app state migration stores full RoughBid project state under workspace RLS', async () => {
  const sql = (await readFile(new URL('../migrations/0013_project_app_state.sql', import.meta.url), 'utf8')).toLowerCase();
  assert.match(sql, /alter table public\.projects/);
  assert.match(sql, /add column if not exists app_state jsonb not null default '\{\}'::jsonb/);
  assert.match(sql, /jsonb_typeof\(app_state\) = 'object'/);
});
