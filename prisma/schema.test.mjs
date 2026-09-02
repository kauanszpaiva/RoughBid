import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const schema = await readFile(new URL('./schema.prisma', import.meta.url), 'utf8');
const migration = await readFile(
  new URL('./migrations/20260902000100_versioned_projects/migration.sql', import.meta.url),
  'utf8',
);

test('quotes pin immutable estimate and plan revisions', () => {
  assert.match(schema, /estimateRevisionId\s+String/);
  assert.match(schema, /planRevisionId\s+String\?/);
  assert.match(migration, /estimate_revisions_immutable/);
  assert.match(migration, /quote_snapshots_protect_content/);
});

test('tenant and project authorization grants are represented', () => {
  assert.match(schema, /model OrganizationMember/);
  assert.match(schema, /model ProjectMember/);
  assert.match(schema, /organizationId\s+String/);
});

test('revision allocation has database concurrency guards', () => {
  assert.match(schema, /@@unique\(\[planId, revisionNumber\]\)/);
  assert.match(schema, /@@unique\(\[estimateId, revisionNumber\]\)/);
});
