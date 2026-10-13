import test from 'node:test';
import assert from 'node:assert/strict';
import { completeTransferredUpload } from '../app/src/utils/uploadCompletion.ts';

test('lost completion acknowledgement retries exactly the saved PDF/photo identity without another transfer', async () => {
  for (const type of ['application/pdf', 'image/png']) {
    const source = new File(['fixture'], 'source', { type }), transferred = new Map<File, string>();
    let transfers = 0, completions = 0;
    const options = {
      isCurrent: () => true,
      transfer: async () => { transfers++; return 'saved-source'; },
      complete: async (id: string) => {
        assert.equal(id, 'saved-source');
        if (++completions === 1) throw new TypeError('Response lost after server saved completion');
        return { id, status: 'ready' };
      },
    };
    await assert.rejects(completeTransferredUpload(source, transferred, options), /Response lost/);
    assert.equal(transferred.get(source), 'saved-source');
    assert.deepEqual(await completeTransferredUpload(source, transferred, options), { id: 'saved-source', status: 'ready' });
    assert.equal(transfers, 1); assert.equal(completions, 2); assert.equal(transferred.size, 0);
  }
});

test('failed transfer can retry and never attempts completion before successful storage', async () => {
  const source = {}, transferred = new Map<object, string>();
  let transfers = 0, completions = 0;
  const options = { isCurrent: () => true,
    transfer: async () => { if (++transfers === 1) throw new Error('Upload interrupted'); return 'saved'; },
    complete: async (id: string) => { completions++; return id; },
  };
  await assert.rejects(completeTransferredUpload(source, transferred, options), /Upload interrupted/);
  assert.equal(transferred.size, 0); assert.equal(completions, 0);
  assert.equal(await completeTransferredUpload(source, transferred, options), 'saved');
  assert.equal(transfers, 2); assert.equal(completions, 1);
});

test('switching workspace/project during transfer never completes or caches the old source', async () => {
  const source = {}, transferred = new Map<object, string>();
  let current = true, completions = 0;
  assert.equal(await completeTransferredUpload(source, transferred, {
    isCurrent: () => current,
    transfer: async () => { current = false; return 'old-source'; },
    complete: async () => { completions++; return {}; },
  }), undefined);
  assert.equal(completions, 0); assert.equal(transferred.size, 0);
});

test('completion from an old project is not applied to a new project', async () => {
  const source = {}, transferred = new Map<object, string>();
  let current = true;
  assert.equal(await completeTransferredUpload(source, transferred, {
    isCurrent: () => current, transfer: async () => 'old-source',
    complete: async () => { current = false; transferred.clear(); return { id: 'old-source' }; },
  }), undefined);
  assert.equal(transferred.size, 0);
});

test('two different files never reuse each other despite matching filenames', async () => {
  const first = new File(['one'], 'same.pdf'), second = new File(['two'], 'same.pdf');
  const transferred = new Map<File, string>([[first, 'first-source']]);
  let transfers = 0;
  assert.equal(await completeTransferredUpload(second, transferred, {
    isCurrent: () => true, transfer: async () => { transfers++; return 'second-source'; }, complete: async id => id,
  }), 'second-source');
  assert.equal(transfers, 1); assert.equal(transferred.get(first), 'first-source');
});
