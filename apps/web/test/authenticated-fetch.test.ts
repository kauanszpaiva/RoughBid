import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createAuthenticatedFetch } from '../app/src/services/authenticatedFetch.ts';

const original = { access_token: 'cached-token', user: { id: 'owner' } };
const renewed = { access_token: 'renewed-token', user: { id: 'owner' } };
type Session = typeof original;
type Result = { data: { session: Session | null }; error: unknown };

function fixture() {
  let session: Session | null = original;
  let refreshCount = 0;
  const signOutScopes: string[] = [];
  const sent: { token: string | null; method: string; workspace: string | null; body: unknown }[] = [];
  const result = (): Result => ({ data: { session }, error: null });
  const hooks = {
    refresh: async (): Promise<Result> => { session = renewed; return result(); },
    respond: async (token: string | null): Promise<Response> => new Response('', { status: token === 'renewed-token' ? 200 : 401 }),
  };
  const auth = {
    getSession: async () => result(),
    refreshSession: async () => { refreshCount++; return hooks.refresh(); },
    signOut: async ({ scope }: { scope: 'local' }) => { signOutScopes.push(scope); session = null; return { error: null }; },
  };
  const fetcher: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    const token = headers.get('Authorization')?.replace('Bearer ', '') ?? null;
    sent.push({ token, method: init?.method ?? 'GET', workspace: headers.get('x-workspace-id'), body: init?.body });
    return hooks.respond(token);
  };
  return { request: createAuthenticatedFetch(auth, fetcher), hooks, sent, signOutScopes,
    setSession: (next: Session | null) => { session = next; },
    getSession: () => session, refreshCount: () => refreshCount };
}

test('rejected cached token refreshes once and repeats the same authenticated read', async () => {
  const f = fixture();
  const response = await f.request('/api/auth/bootstrap', { headers: { 'x-workspace-id': 'workspace-1' } });
  assert.equal(response.status, 200);
  assert.deepEqual(f.sent.map(call => [call.token, call.workspace]), [['cached-token', 'workspace-1'], ['renewed-token', 'workspace-1']]);
  assert.equal(f.refreshCount(), 1);
  assert.deepEqual(f.signOutScopes, []);
});

test('POST, PATCH and DELETE are never replayed after authorization failure', async () => {
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const f = fixture();
    assert.equal((await f.request('/api/projects/project/reading-checkout', { method, body: '{"quoteId":"quote"}' })).status, 401);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].body, '{"quoteId":"quote"}');
    assert.equal(f.refreshCount(), 0);
    assert.deepEqual(f.signOutScopes, []);
  }
});

test('a second rejected read stops with an actionable sign-in error', async () => {
  const f = fixture();
  f.hooks.respond = async () => new Response('', { status: 401 });
  await assert.rejects(f.request('/api/workspaces'), (error: unknown) => error instanceof ApiError && error.status === 401 && /Open Account.*sign in again/.test(error.message));
  assert.equal(f.sent.length, 2);
  assert.equal(f.refreshCount(), 1);
  assert.equal(f.getSession(), renewed);
  assert.deepEqual(f.signOutScopes, []);
});

test('parallel rejected reads share one pending refresh', async () => {
  const f = fixture();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.hooks.refresh = async () => { await pending; f.setSession(renewed); return { data: { session: renewed }, error: null }; };
  const a = f.request('/api/workspaces');
  const b = f.request('/api/projects');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.refreshCount(), 1);
  release();
  assert.deepEqual((await Promise.all([a, b])).map(response => response.status), [200, 200]);
  assert.equal(f.sent.length, 4);
});

test('an already renewed token is reused without forcing another refresh', async () => {
  const f = fixture();
  f.hooks.respond = async token => {
    if (token === original.access_token) { f.setSession(renewed); return new Response('', { status: 401 }); }
    return new Response('', { status: 200 });
  };
  assert.equal((await f.request('/api/projects')).status, 200);
  assert.equal(f.refreshCount(), 0);
  assert.deepEqual(f.sent.map(call => call.token), ['cached-token', 'renewed-token']);
});

test('switching accounts while the first request runs cannot replay an old workspace read', async () => {
  const f = fixture();
  const different = { access_token: 'different-token', user: { id: 'different-user' } };
  f.hooks.respond = async () => { f.setSession(different); return new Response('', { status: 401 }); };
  await assert.rejects(f.request('/api/projects'), { status: 401 });
  assert.equal(f.sent.length, 1);
  assert.equal(f.refreshCount(), 0);
  assert.equal(f.getSession(), different);
  assert.deepEqual(f.signOutScopes, []);
});

test('switching accounts during refresh cannot replay or sign out the new account', async () => {
  const f = fixture();
  const different = { access_token: 'different-token', user: { id: 'different-user' } };
  f.hooks.refresh = async () => { f.setSession(different); return { data: { session: different }, error: null }; };
  await assert.rejects(f.request('/api/projects'), { status: 401 });
  assert.equal(f.sent.length, 1);
  assert.equal(f.getSession(), different);
  assert.deepEqual(f.signOutScopes, []);
});

test('definitively invalid or missing refresh returns to local sign-in only', async () => {
  for (const error of [
    { code: 'refresh_token_not_found' }, { code: 'refresh_token_already_used' },
    { code: 'session_not_found' }, { code: 'session_expired' }, { name: 'AuthSessionMissingError' }, null,
  ]) {
    const f = fixture();
    f.hooks.refresh = async () => ({ data: { session: null }, error });
    await assert.rejects(f.request('/api/auth/bootstrap'), (caught: unknown) => caught instanceof ApiError && caught.status === 401 && /sign in again/.test(caught.message));
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.signOutScopes, ['local']);
    assert.equal(f.getSession(), null);
  }
});

test('an invalid refresh from an old request cannot clear a newer login or token', async () => {
  for (const replacement of [renewed, { access_token: 'different-token', user: { id: 'different-user' } }]) {
    const f = fixture();
    f.hooks.refresh = async () => {
      f.setSession(replacement);
      return { data: { session: null }, error: { code: 'refresh_token_not_found' } };
    };
    await assert.rejects(f.request('/api/projects'), { status: 401 });
    assert.equal(f.sent.length, 1);
    assert.equal(f.getSession(), replacement);
    assert.deepEqual(f.signOutScopes, []);
  }
});

test('temporary refresh outages and unclassified errors preserve the saved session', async () => {
  for (const error of [{ name: 'AuthRetryableFetchError', status: 503 }, { status: 401 }, { code: 'unexpected_failure' }]) {
    const f = fixture();
    f.hooks.refresh = async () => ({ data: { session: null }, error });
    await assert.rejects(f.request('/api/auth/bootstrap'), { status: 503 });
    assert.equal(f.sent.length, 1);
    assert.equal(f.getSession(), original);
    assert.deepEqual(f.signOutScopes, []);
  }
  const f = fixture();
  f.hooks.refresh = async () => { throw new TypeError('Network unavailable'); };
  await assert.rejects(f.request('/api/auth/bootstrap'), { status: 503 });
  assert.equal(f.getSession(), original);
  assert.deepEqual(f.signOutScopes, []);
});

test('successful reads and anonymous requests never initiate forced refresh', async () => {
  const f = fixture();
  f.hooks.respond = async () => new Response('', { status: 200 });
  assert.equal((await f.request('/api/projects')).status, 200);
  f.setSession(null);
  assert.equal((await f.request('/api/health')).status, 200);
  assert.equal(f.sent[1].token, null);
  assert.equal(f.refreshCount(), 0);
});
