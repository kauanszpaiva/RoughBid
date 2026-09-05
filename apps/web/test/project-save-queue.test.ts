import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectSaveQueue } from '../app/src/utils/projectSaveQueue.ts';

type Draft = { id: string; value: number };
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('a delayed first save cannot overwrite newer edits; writes stay ordered', async () => {
  const first = deferred();
  const second = deferred();
  const writes: number[] = [];
  let stored = 0;
  const queue = new ProjectSaveQueue<Draft>(async (draft) => {
    writes.push(draft.value);
    await (writes.length === 1 ? first.promise : second.promise);
    stored = draft.value;
  }, () => {});
  queue.enqueue({ id: 'one', value: 1 });
  queue.enqueue({ id: 'one', value: 2 });
  queue.enqueue({ id: 'one', value: 3 });
  assert.deepEqual(writes, [1]);
  first.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, [1, 3]);
  assert.deepEqual(queue.getPending(), [{ id: 'one', value: 3 }]);
  second.resolve();
  await queue.wait('one');
  assert.equal(stored, 3);
  assert.deepEqual(queue.getPending(), []);
});

test('a failed save retains the newest draft and retries it explicitly', async () => {
  const first = deferred();
  const writes: number[] = [];
  const states: string[] = [];
  const queue = new ProjectSaveQueue<Draft>(async (draft) => {
    writes.push(draft.value);
    if (writes.length === 1) await first.promise;
  }, (_id, state) => states.push(state));
  queue.enqueue({ id: 'one', value: 1 });
  queue.enqueue({ id: 'one', value: 2 });
  first.reject(new Error('offline'));
  await assert.rejects(queue.wait('one'), /pending changes/);
  assert.deepEqual(queue.getPending(), [{ id: 'one', value: 2 }]);
  assert.equal(states.at(-1), 'error');
  queue.retry('one');
  await queue.wait('one');
  assert.deepEqual(writes, [1, 2]);
  assert.equal(states.at(-1), 'saved');
});

test('changing account stops later writes and suppresses stale completion events', async () => {
  const first = deferred();
  const writes: number[] = [];
  const states: string[] = [];
  const queue = new ProjectSaveQueue<Draft>(async (draft) => {
    writes.push(draft.value);
    await first.promise;
  }, (_id, state) => states.push(state));
  queue.enqueue({ id: 'one', value: 1 });
  queue.enqueue({ id: 'one', value: 2 });
  queue.stop();
  first.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, [1]);
  assert.equal(states.includes('saved'), false);
});

test('recovered drafts stay pending until the user retries saving', async () => {
  const writes: number[] = [];
  const queue = new ProjectSaveQueue<Draft>(async (draft) => { writes.push(draft.value); }, () => {});
  queue.recover({ id: 'one', value: 8 });
  assert.deepEqual(writes, []);
  await assert.rejects(queue.wait('one'), /pending changes/);
  queue.retry('one');
  await queue.wait('one');
  assert.deepEqual(writes, [8]);
});
