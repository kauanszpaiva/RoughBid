import test from 'node:test';
import assert from 'node:assert/strict';
import { probeReadingSchema } from '../../../scripts/probe-reading-schema.mjs';
const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test_only' };

test('schema preflight validates the exact composite relationship with a zero-row read', async () => {
  let requested: URL | undefined;
  let options: RequestInit | undefined;
  const actual = await probeReadingSchema(env, async (url, init) => {
    requested = new URL(url); options = init;
    return Response.json([]);
  });
  assert.equal(actual.status, 'available');
  assert.equal(requested?.pathname, '/rest/v1/plan_reading_jobs');
  assert.equal(requested?.searchParams.get('limit'), '0');
  assert.match(requested?.searchParams.get('select') ?? '', /!plan_reading_findings_job_workspace_project_file_fkey/);
  assert.equal(options?.method, 'GET');
  assert.equal(options?.body, undefined);
  assert.ok(!JSON.stringify(actual).includes(env.SUPABASE_SERVICE_ROLE_KEY));
});

test('ambiguous relationships are reported without raw database messages', async () => {
  const actual = await probeReadingSchema(env, async () => Response.json({ code: 'PGRST201', message: 'PRIVATE DATA' }, { status: 300 }));
  assert.equal(actual.status, 'unavailable');
  assert.equal(actual.code, 'PGRST201');
  assert.ok(!JSON.stringify(actual).includes('PRIVATE DATA'));
});

test('schema preflight never sends server credentials to a non-Supabase host or uses missing configuration', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return Response.json([]); };
  for (const changed of [{ SUPABASE_URL: 'https://untrusted.example' }, { SUPABASE_SERVICE_ROLE_KEY: '' }]) {
    assert.equal((await probeReadingSchema({ ...env, ...changed }, fetcher)).status, 'unconfigured');
  }
  assert.equal(calls, 0);
});
