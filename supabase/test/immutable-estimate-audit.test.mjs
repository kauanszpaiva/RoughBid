import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('estimate audit ledger records every write and cannot be mutated', async () => {
  const sql = (await readFile(
    new URL('../migrations/0004_immutable_estimate_audit.sql', import.meta.url),
    'utf8',
  )).toLowerCase();

  for (const required of [
    'create table public.estimate_audit_log',
    'after insert or update on public.estimates',
    'to_jsonb(new)',
    'to_jsonb(old)',
    'auth.uid()',
    'changed_fields',
    'transaction_id',
    'security definer',
    'before update or delete on public.estimate_audit_log',
    'estimate audit records are immutable',
    'revoke insert, update, delete, truncate',
    'create policy estimate_audit_log_select_access',
  ]) {
    assert.match(sql, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
