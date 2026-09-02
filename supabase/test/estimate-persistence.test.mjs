import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('estimate persistence stores all derived fields and protects lifecycle', async () => {
  const sql = (await readFile(new URL('../migrations/0003_estimate_persistence.sql', import.meta.url), 'utf8')).toLowerCase();
  for (const required of ['cost_with_overhead', 'markup_amount', 'gross_margin_percent',
    'finalized_at', 'final estimates are immutable', 'new.version <> old.version',
    'pg_advisory_xact_lock']) {
    assert.match(sql, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
