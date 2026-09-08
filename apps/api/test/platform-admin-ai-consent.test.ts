import test from 'node:test';
import assert from 'node:assert/strict';
import { grantAiProcessingConsent } from '../src/workspaces/actions.ts';
import { handleWorkspacesRequest } from '../src/workspaces/routes.ts';
import { ApiActionError } from '../src/supabase/client.ts';

function result(data: unknown, error: { message: string } | null = null) {
  const query: any = {
    select() { return query; },
    update() { return query; },
    eq() { return query; },
    order() { return query; },
    single: async () => ({ data, error }),
    then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data, error }).then(resolve); },
  };
  return query;
}

function authenticatedClient(options: { platformAdmin?: boolean; role?: string; creator?: boolean } = {}) {
  const { platformAdmin = true, role = 'admin', creator = false } = options;
  let authenticatedWorkspaceWrites = 0;
  const userId = 'platform-admin';
  const creatorId = creator ? userId : 'workspace-creator';
  const workspaceRow = { id: 'workspace', name: 'JKA', created_by: creatorId, created_at: '2026-09-08T00:00:00Z', ai_processing_consented_at: null };
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) },
    from(table: string) {
      if (table === 'profiles') return result({ id: userId, is_platform_admin: platformAdmin });
      if (table === 'workspace_members') return result({ workspace_id: 'workspace', user_id: userId, role });
      if (table === 'workspaces') {
        const query: any = result(workspaceRow);
        query.update = () => {
          authenticatedWorkspaceWrites += 1;
          return creator
            ? result({ ...workspaceRow, ai_processing_consented_at: '2026-09-08T19:00:00Z' })
            : result(null, { message: 'new row violates row-level security policy' });
        };
        return query;
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  };
  return { client, authenticatedWorkspaceWrites: () => authenticatedWorkspaceWrites };
}

function privilegedWriter() {
  let writes = 0;
  const writer = {
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    from(table: string) {
      if (table !== 'workspaces') throw new Error(`Unexpected writer table: ${table}`);
      const query: any = result({ id: 'workspace', name: 'JKA', created_by: 'workspace-creator', created_at: '2026-09-08T00:00:00Z', ai_processing_consented_at: '2026-09-08T19:00:00Z' });
      query.update = () => { writes += 1; return query; };
      return query;
    },
  };
  return { writer, writes: () => writes };
}

test('platform admin who is an explicit workspace admin can record consent without impersonating the creator', async () => {
  const auth = authenticatedClient();
  const privileged = privilegedWriter();

  const workspace = await grantAiProcessingConsent(auth.client as never, 'workspace', privileged.writer as never);

  assert.equal(workspace?.id, 'workspace');
  assert.equal(privileged.writes(), 1);
  assert.equal(auth.authenticatedWorkspaceWrites(), 0);
});

test('platform admin viewer cannot use the privileged consent writer', async () => {
  const auth = authenticatedClient({ role: 'viewer' });
  const privileged = privilegedWriter();

  await assert.rejects(
    grantAiProcessingConsent(auth.client as never, 'workspace', privileged.writer as never),
    (error: unknown) => error instanceof ApiActionError && error.status === 403,
  );
  assert.equal(privileged.writes(), 0);
});

test('ordinary workspace admin who is not the creator cannot use the privileged writer', async () => {
  const auth = authenticatedClient({ platformAdmin: false, role: 'admin' });
  const privileged = privilegedWriter();

  await assert.rejects(
    grantAiProcessingConsent(auth.client as never, 'workspace', privileged.writer as never),
    (error: unknown) => error instanceof ApiActionError && error.status === 403,
  );
  assert.equal(privileged.writes(), 0);
});

test('workspace creator keeps the existing authenticated RLS write path', async () => {
  const auth = authenticatedClient({ platformAdmin: false, role: 'admin', creator: true });
  const privileged = privilegedWriter();

  const workspace = await grantAiProcessingConsent(auth.client as never, 'workspace', privileged.writer as never);

  assert.equal(workspace?.id, 'workspace');
  assert.equal(auth.authenticatedWorkspaceWrites(), 1);
  assert.equal(privileged.writes(), 0);
});

test('ai-consent route forwards the privileged writer only after an explicit POST', async () => {
  const auth = authenticatedClient();
  const privileged = privilegedWriter();
  const response = await handleWorkspacesRequest(
    new Request('https://roughbid.test/api/workspaces/workspace/ai-consent', { method: 'POST' }),
    auth.client as never,
    { consentWriter: privileged.writer as never } as never,
  );

  assert.equal(response.status, 200);
  assert.equal(privileged.writes(), 1);
  assert.equal(auth.authenticatedWorkspaceWrites(), 0);
});
