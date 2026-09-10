import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../migrations/0037_platform_admin_daily_limit.sql', import.meta.url), 'utf8');

test('platform owner cap is atomic, global, failure-retaining, and service-only', () => {
  const profileLock = sql.indexOf('from public.profiles');
  const count = sql.indexOf('select count(*) into used');
  const insert = sql.indexOf('insert into public.plan_reading_jobs');
  assert.ok(profileLock >= 0 && profileLock < count && count < insert, 'lock, count, then insert');
  assert.match(sql, /daily_limit constant integer := 25/);
  assert.match(sql, /where requested_by = p_user_id[\s\S]*created_at > now\(\) - interval '24 hours'/);
  const countedSlice = sql.slice(count, sql.indexOf('if used >= daily_limit'));
  assert.doesNotMatch(countedSlice, /status\s*(=|in)/i, 'failed attempts remain counted');
  assert.match(sql, /revoke all on function[\s\S]*from public, anon, authenticated/);
  assert.match(sql, /grant execute on function[\s\S]*to service_role/);
});
