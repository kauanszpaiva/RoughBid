import test from 'node:test';
import assert from 'node:assert/strict';
import { requirePlatformAdminPlanReadingConfig } from '../src/ai-plan/readiness.ts';
import { runtimeCapabilities } from '../src/http/capabilities.ts';
import { handleAiPlanRequest } from '../src/ai-plan/routes.ts';

const env = { PLATFORM_ADMIN_PLAN_READINGS_ENABLED: 'true', PLATFORM_ADMIN_GEMINI_MODEL: 'gemini-3.8-flash',
  GEMINI_API_KEY: 'unit-gemini-credential' };
test('administrator reader requires explicit activation, exact cheap model and an unmasked credential', () => {
  assert.equal(requirePlatformAdminPlanReadingConfig(env).model, 'gemini-3.8-flash');
  for (const change of [{ PLATFORM_ADMIN_PLAN_READINGS_ENABLED: 'false' },
    { PLATFORM_ADMIN_GEMINI_MODEL: 'gemini-3.1-pro-preview' }, { GEMINI_API_KEY: '[SENSITIVE]' }]) {
    assert.throws(() => requirePlatformAdminPlanReadingConfig({ ...env, ...change }));
  }
  assert.equal(runtimeCapabilities(env).aiReadingAvailable, false, 'admin activation does not advertise paid/customer reading');
});

function query(data: unknown) {
  const value: any = {};
  for (const method of ['select', 'eq', 'maybeSingle']) value[method] = () => value;
  value.then = (resolve: any) => Promise.resolve({ data, error: null }).then(resolve);
  return value;
}
test('administrator page reader cannot be invoked by a customer or through a foreign project', async () => {
  for (const [admin, project] of [[false, true], [true, false]]) {
    let calls = 0;
    const db: any = { auth: { getUser: async () => ({ data: { user: { id: 'user' } }, error: null }) },
      from(table: string) {
        return query(table === 'profiles' ? { is_platform_admin: admin } : table === 'workspace_members'
          ? { role: 'estimator' } : table === 'projects' ? (project ? { id: 'project' } : null)
          : { ai_processing_consented_at: '2026-10-05' });
      } };
    const response = await handleAiPlanRequest(new Request('https://test/api/projects/project/ai-plan-readings', {
      method: 'POST', headers: { 'x-workspace-id': 'workspace', 'content-type': 'application/json' },
      body: JSON.stringify({ file_id: 'file', page_number: 1 }),
    }), db, { findingsWriter: { from: () => { throw new Error('No persistence permitted'); } },
      storage: { presign: async () => { throw new Error('No download permitted'); } },
      reader: { read: async () => { throw new Error('No customer reader'); } },
      platformAdminReader: { read: async () => { calls++; throw new Error('Must not invoke'); } }, paidReaderAvailable: false });
    assert.equal(response.status, 403);
    assert.equal(calls, 0);
  }
});
