import assert from 'node:assert/strict';
import test from 'node:test';
import { clearSavedReadingQuote, restoreSavedReadingQuote, saveReadingQuoteId } from '../app/src/services/reading-quote-session.ts';
import type { ReadingQuote } from '../app/src/services/api.ts';

const context = { workspaceId: 'workspace-a', projectId: 'project-a', fileId: 'file-a' };
const quoteId = 'c8c86b8e-2091-4ac5-a458-9b4c06090561';
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
}
function quote(patch: Partial<ReadingQuote> = {}): ReadingQuote {
  return { id: quoteId, project_id: context.projectId, file_id: context.fileId, amount_cents: 1500, currency: 'usd',
    page_count: 3, trades: ['Concrete', 'Framing'], scope: 'Original paid scope', status: 'quoted', attempts: 0,
    max_attempts: 2, job_id: null, expires_at: '2026-09-08T12:00:00.000Z', membership: 'standard', ...patch };
}

test('checkout reload restores the exact subset and authoritative paid quote using only the saved ID', async () => {
  const local = storage();
  const beforeCheckout = quote();
  saveReadingQuoteId(local, context, beforeCheckout.id);
  assert.deepEqual([...local.values.values()], [quoteId]);
  const requests: string[][] = [];
  const afterWebhook = quote({ status: 'paid', amount_cents: 1700 });
  const restored = await restoreSavedReadingQuote(local, context, async (...args) => { requests.push(args); return afterWebhook; });
  assert.deepEqual(requests, [[context.workspaceId, context.projectId, context.fileId, quoteId]]);
  assert.deepEqual(restored?.trades, ['Concrete', 'Framing']);
  assert.equal(restored?.scope, 'Original paid scope');
  assert.equal(restored?.status, 'paid');
  assert.equal(restored?.amount_cents, 1700);
});

test('a forged local paid object cannot supply payment status or trigger a request', async () => {
  const local = storage();
  saveReadingQuoteId(local, context, quoteId);
  local.values.set([...local.values.keys()][0]!, JSON.stringify(quote({ status: 'paid', amount_cents: 0 })));
  let calls = 0;
  await assert.rejects(restoreSavedReadingQuote(local, context, async () => { calls++; return quote({ status: 'paid' }); }), /reference is invalid/);
  assert.equal(calls, 0);
});

test('workspace, project and file changes never fetch or restore another context', async () => {
  const local = storage();
  saveReadingQuoteId(local, context, quoteId);
  for (const changed of [{ ...context, workspaceId: 'workspace-b' }, { ...context, projectId: 'project-b' }, { ...context, fileId: 'file-b' }]) {
    const restored = await restoreSavedReadingQuote(local, changed, async () => { assert.fail('Unexpected cross-context fetch'); });
    assert.equal(restored, null);
  }
});

test('server identity mismatches and invalid expiry fail without removing the recovery reference', async () => {
  const local = storage();
  saveReadingQuoteId(local, context, quoteId);
  for (const mismatch of [{ id: '0ea118c9-3336-4ce7-9c79-002d1a63ec69' }, { project_id: 'project-b' }, { file_id: 'file-b' }, { expires_at: 'invalid' }]) {
    await assert.rejects(restoreSavedReadingQuote(local, context, async () => quote(mismatch)), /could not be verified/);
    assert.deepEqual([...local.values.values()], [quoteId]);
  }
});

test('unavailable service fails closed and retry reads its new authoritative status', async () => {
  const local = storage();
  saveReadingQuoteId(local, context, quoteId);
  await assert.rejects(restoreSavedReadingQuote(local, context, async () => { throw new Error('Reading service unavailable'); }), /unavailable/);
  assert.deepEqual([...local.values.values()], [quoteId]);
  for (const status of ['quoted', 'revoked', 'failed', 'processing', 'complete'] as const) {
    const restored = await restoreSavedReadingQuote(local, context, async () => quote({ status }));
    assert.equal(restored?.status, status);
    assert.notEqual(restored?.status, 'paid');
  }
});

test('an intentional scope change clears the saved ID before a new quote is requested', async () => {
  const local = storage();
  saveReadingQuoteId(local, context, quoteId);
  clearSavedReadingQuote(local, context);
  assert.equal(local.values.size, 0);
  assert.equal(await restoreSavedReadingQuote(local, context, async () => { assert.fail('Old scope should not be fetched'); }), null);
});

test('browser storage failures are propagated so checkout cannot proceed without recovery', async () => {
  const local = { getItem: () => { throw new Error('Storage disabled'); }, setItem: () => { throw new Error('Storage disabled'); }, removeItem: () => {} };
  assert.throws(() => saveReadingQuoteId(local, context, quoteId), /Storage disabled/);
  await assert.rejects(restoreSavedReadingQuote(local, context, async () => quote()), /Storage disabled/);
});
