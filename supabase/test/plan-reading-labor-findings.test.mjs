import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('plan reading labor finding migration widens finding_type without weakening RLS', async () => {
  const sql = (await readFile(new URL('../migrations/0014_plan_reading_labor_findings.sql', import.meta.url), 'utf8')).toLowerCase();
  assert.match(sql, /drop constraint plan_reading_findings_finding_type_check/);
  assert.match(sql, /add constraint plan_reading_findings_finding_type_check/);
  assert.match(sql, /'material', 'labor'/);
  assert.equal(sql.includes('disable row level security'), false);
  assert.equal(sql.includes('grant all'), false);
  assert.equal(sql.includes(' to anon'), false);
});
