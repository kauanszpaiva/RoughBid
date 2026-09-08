import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { hasPlatformAdminProjectAccess } from '../src/access/platform-admin.ts';
import { handleAiPlanRequest } from '../src/ai-plan/routes.ts';
import { ProjectPayments } from '../src/billing/project-payments.ts';
import { ProjectApiError } from '../src/projects/service.ts';

function result(data: unknown, error: unknown = null) {
  const query: any = {};
  for (const method of ['select', 'eq', 'maybeSingle', 'single']) query[method] = () => query;
  query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error }).then(resolve);
  return query;
}

function database(options: { platformAdmin?: boolean; role?: string | null; projectExists?: boolean; consent?: string | null } = {}) {
  const { platformAdmin = true, role = 'admin', projectExists = true, consent = null } = options;
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'founder' } }, error: null }) },
    from(table: string) {
      if (table === 'profiles') return result({ is_platform_admin: platformAdmin });
      if (table === 'workspace_members') return result(role ? { role } : null);
      if (table === 'projects') return result(projectExists ? { id: 'project' } : null);
      if (table === 'workspaces') return result({ id: 'workspace', ai_processing_consented_at: consent });
      throw new Error(`Unexpected table read: ${table}`);
    },
    rpc: async () => { throw new Error('This check must not persist anything.'); },
  };
}

test('founder commercial access remains visible before AI processing consent', async () => {
  assert.equal(await hasPlatformAdminProjectAccess(database(), 'founder', 'workspace', 'project'), true);
});

test('missing consent never exposes a paid quote to the founder', async () => {
  let downloaded = false;
  const payments = new ProjectPayments(database() as never, {});
  await assert.rejects(
    payments.quote('founder', 'workspace', 'project', { file_id: 'file' }, {
      presign: async () => { downloaded = true; throw new Error('Must not download a plan to price the founder.'); },
    }),
    (error: unknown) => error instanceof ProjectApiError && error.status === 409 && /complimentary/i.test(error.message),
  );
  assert.equal(downloaded, false);
});

test('entitlement before consent never grants another tenant, viewer, or customer a founder exemption', async () => {
  for (const options of [{ role: 'viewer' }, { role: null }, { projectExists: false }, { platformAdmin: false }]) {
    assert.equal(await hasPlatformAdminProjectAccess(database(options), 'founder', 'workspace', 'project'), false);
  }
});

test('founder GET entitlement succeeds without consent but POST still blocks before provider or reservation', async () => {
  let invoked = false;
  const deps = {
    findingsWriter: { from: () => { throw new Error('Unexpected write'); }, rpc: async () => { invoked = true; throw new Error('No consent'); } },
    storage: { presign: async () => { invoked = true; throw new Error('No consent'); } },
    reader: { read: async () => { invoked = true; throw new Error('No consent'); } },
    paidReaderAvailable: true,
  };
  const headers = { 'x-workspace-id': 'workspace', 'content-type': 'application/json' };
  const entitlement = await handleAiPlanRequest(new Request('https://test.local/api/projects/project/ai-plan-entitlement', { headers }), database() as never, deps);
  assert.deepEqual(await entitlement.json(), { freeReadingAvailable: true });
  const start = await handleAiPlanRequest(new Request('https://test.local/api/projects/project/ai-plan-readings', {
    method: 'POST', headers, body: JSON.stringify({ file_id: 'file' }),
  }), database() as never, deps);
  assert.equal(start.status, 403);
  assert.match((await start.json() as { error: string }).error, /accept AI|consent|processing/i);
  assert.equal(invoked, false);
});

test('Vercel exposes the explicit AI consent and finding-review routes', () => {
  for (const path of ['../../../api/workspaces/[id]/ai-consent.ts', '../../../api/ai-plan-readings/findings/[id].ts']) {
    assert.equal(existsSync(new URL(path, import.meta.url)), true, `Missing production route: ${path}`);
  }
});

test('plans UI removes every paid-reading action once complimentary entitlement is known', () => {
  const plans = readFileSync(new URL('../../web/app/src/pages/PlansPage.tsx', import.meta.url), 'utf8');
  assert.match(plans, /if \(freeReadingAvailable\) setReadingQuote\(null\)/);
  assert.match(plans, /\{!freeReadingAvailable && readingQuote/);
  assert.match(plans, /\{!freeReadingAvailable && \(\s*<button[\s\S]*?handleStartAiReading/);
});
