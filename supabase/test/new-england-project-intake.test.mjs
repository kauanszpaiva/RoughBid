import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../migrations/20260911153000_new_england_project_intake.sql', import.meta.url), 'utf8');

test('New England intake migration stores dated structured jurisdiction fields', () => {
  for (const column of ['client_name', 'project_type', 'jurisdiction_state', 'municipality', 'postal_code', 'permit_date']) {
    assert.match(migration, new RegExp(`add column ${column}\\b`));
  }
  for (const state of ['CT', 'MA', 'ME', 'NH', 'RI', 'VT']) assert.match(migration, new RegExp(`'${state}'`));
  assert.match(migration, /projects_jurisdiction_idx/);
});
