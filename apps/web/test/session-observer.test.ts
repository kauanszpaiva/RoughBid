import test from 'node:test';
import assert from 'node:assert/strict';
import { observeSession, type SessionSnapshot } from '../app/src/services/sessionObserver.ts';

type Session = { user: { id: string } };
const current = { user: { id: 'current-user' } };
const previous = { user: { id: 'previous-user' } };

function fixture() {
  const snapshots: SessionSnapshot<Session>[] = [];
  let receive!: (event: string, session: Session | null) => void;
  let resolve!: (result: { data: { session: Session | null }; error?: unknown }) => void;
  let reject!: (error: unknown) => void;
  let unsubscribed = 0;
  const lookup = new Promise<{ data: { session: Session | null }; error?: unknown }>((yes, no) => { resolve = yes; reject = no; });
  const auth = {
    getSession: () => lookup,
    onAuthStateChange(callback: typeof receive) { receive = callback; return { data: { subscription: { unsubscribe: () => { unsubscribed++; } } } }; },
  };
  return { auth, snapshots, resolve, reject, event: (session: Session | null) => receive('SIGNED_IN', session), unsubscribed: () => unsubscribed };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('saved sessions and normal signed-out state resolve without an error', async () => {
  for (const session of [current, null]) {
    const f = fixture(); const stop = observeSession(f.auth, (value) => f.snapshots.push(value));
    f.resolve({ data: { session } }); await settle();
    assert.deepEqual(f.snapshots, [{ session, loading: false, error: null }]); stop();
  }
});

test('a late lookup cannot restore an account after a newer sign-in or sign-out', async () => {
  for (const session of [current, null]) {
    const f = fixture(); const stop = observeSession(f.auth, (value) => f.snapshots.push(value));
    f.event(session); f.resolve({ data: { session: previous } }); await settle();
    assert.deepEqual(f.snapshots, [{ session, loading: false, error: null }]); stop();
  }
});

test('a failed lookup preserves a known session and exposes safe retry copy', async () => {
  const f = fixture(); const stop = observeSession(f.auth, (value) => f.snapshots.push(value), { initialSession: current });
  f.resolve({ data: { session: null }, error: { message: 'secret-token-never-display' } }); await settle();
  assert.equal(f.snapshots[0].session, current);
  assert.match(f.snapshots[0].error!, /Try again/);
  assert.doesNotMatch(f.snapshots[0].error!, /secret-token/); stop();
});

test('a thrown lookup failure remains recoverable and a later auth event clears it', async () => {
  const f = fixture(); const stop = observeSession(f.auth, (value) => f.snapshots.push(value));
  f.reject(new TypeError('private URL')); await settle();
  assert.equal(f.snapshots[0].loading, false); assert.match(f.snapshots[0].error!, /restore/);
  f.event(current);
  assert.deepEqual(f.snapshots[1], { session: current, loading: false, error: null }); stop();
});

test('a stuck lookup shows a retry state but a later valid result still recovers', async () => {
  const f = fixture(); const stop = observeSession(f.auth, (value) => f.snapshots.push(value), { timeoutMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(f.snapshots[0].loading, false); assert.match(f.snapshots[0].error!, /too long/);
  f.resolve({ data: { session: current } }); await settle();
  assert.deepEqual(f.snapshots[1], { session: current, loading: false, error: null }); stop();
});

test('cleanup unsubscribes and discards pending lookup and auth events', async () => {
  const f = fixture(); const stop = observeSession(f.auth, (value) => f.snapshots.push(value));
  stop(); f.event(current); f.resolve({ data: { session: previous } }); await settle();
  assert.deepEqual(f.snapshots, []); assert.equal(f.unsubscribed(), 1);
});

test('a fresh observer can retry a failed resolution without restoring stale state', async () => {
  const snapshots: SessionSnapshot<Session>[] = [];
  const failed = fixture(); const firstStop = observeSession(failed.auth, (value) => snapshots.push(value));
  failed.reject(new TypeError('offline')); await settle(); firstStop();
  const retried = fixture(); const nextStop = observeSession(retried.auth, (value) => snapshots.push(value));
  retried.resolve({ data: { session: current } }); await settle();
  assert.deepEqual(snapshots[1], { session: current, loading: false, error: null }); nextStop();
});
