import test from 'node:test';
import assert from 'node:assert/strict';
import { DocumentService, type DocumentObjectStorage, type JobQueue } from '../src/documents/service.ts';

function fixture(queue: JobQueue | null = null, responseBytes = 15, initialStatus = 'uploading') {
  let row: any = {
    id: 'file-1', workspace_id: 'workspace-1', project_id: 'project-1',
    original_name: 'plan.pdf', byte_size: 15, page_count: null,
    storage_path: 'workspace-1/project-1/file-1/source.pdf',
    processing_status: initialStatus, metadata: {},
  };
  const signed: string[] = [];
  const db = { from: (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let changes: any;
    const query: any = {
      select: () => query,
      eq: (column: string, value: unknown) => { filters.push([column, value]); return query; },
      update: (input: any) => { changes = input; return query; },
      insert: (input: any) => { row = { ...input, page_count: null, metadata: {} }; return query; },
      single: () => query, maybeSingle: () => query, limit: () => query,
      then: (resolve: any, reject: any) => {
        const target = table === 'workspace_members' ? { user_id: 'user-1', workspace_id: 'workspace-1', role: 'admin' } : table === 'projects' ? { id: 'project-1', workspace_id: 'workspace-1' } : row;
        const matches = filters.every(([column, value]) => target[column] === value);
        if (matches && changes) row = { ...row, ...changes };
        return Promise.resolve({ data: matches ? (table === 'project_files' ? row : target) : null, error: null }).then(resolve, reject);
      },
    };
    return query;
  }};
  const storage: DocumentObjectStorage = { presign: async (method, key) => {
    signed.push(method);
    return { url: 'https://storage.example/' + key, method, headers: {}, expiresAt: '2099-01-01' };
  }};
  const fetcher = (async () => new Response(null, { headers: { 'content-length': String(responseBytes), 'content-type': 'application/pdf' } })) as typeof fetch;
  return { service: new DocumentService(db, storage, queue, 'user-1', 'workspace-1', fetcher), db, storage, fetcher, signed, row: () => row };
}

test('original PDF upload completes and downloads without a queue or generated page count', async () => {
  const f = fixture();
  const begun = await f.service.beginUpload('project-1', { name: 'plan.pdf', contentType: 'application/pdf', byteSize: 15 });
  assert.equal(begun.upload.method, 'PUT');
  const completed = await f.service.completeUpload(begun.file.id);
  assert.equal(completed.processing_status, 'ready');
  assert.equal(completed.page_count, null);
  assert.equal(completed.metadata.page_processing, 'not_requested');
  assert.equal((await f.service.download(begun.file.id)).method, 'GET');
  assert.deepEqual(f.signed, ['PUT', 'HEAD', 'GET']);
});

test('verified original stays available when optional page queue fails', async () => {
  const f = fixture({ add: async () => { throw new Error('Queue unavailable'); } });
  const completed = await f.service.completeUpload('file-1');
  assert.equal(completed.processing_status, 'ready');
  assert.equal(completed.metadata.page_processing, 'unavailable');
  assert.equal((await f.service.download('file-1', { disposition: 'inline' })).method, 'GET');
});

test('configured page processing still queues a verified upload', async () => {
  let queued: any;
  const f = fixture({ add: async (_name, data) => { queued = data; } });
  const completed = await f.service.completeUpload('file-1');
  assert.equal(completed.processing_status, 'queued');
  assert.equal(queued.fileId, 'file-1');
  assert.equal(queued.workspaceId, 'workspace-1');
});

test('manual completion recovers a previously queued original without fabricating page images', async () => {
  const f = fixture(null, 15, 'queued');
  const completed = await f.service.completeUpload('file-1');
  assert.equal(completed.processing_status, 'ready');
  assert.equal(completed.page_count, null);
});

test('manual mode still rejects mismatched uploads and another workspace before signing', async () => {
  const f = fixture(null, 16);
  await assert.rejects(f.service.completeUpload('file-1'), (error: any) => error.status === 422);
  assert.equal(f.row().processing_status, 'uploading');
  f.signed.length = 0;
  const other = new DocumentService(f.db, f.storage, null, 'user-2', 'workspace-2', f.fetcher);
  await assert.rejects(other.download('file-1'), (error: any) => error.status === 404);
  await assert.rejects(other.beginUpload('project-1', { name: 'plan.pdf', contentType: 'application/pdf', byteSize: 15 }), (error: any) => error.status === 403);
  assert.deepEqual(f.signed, []);
});

test('completion uses a server writer after scoped browser reads and storage verification', async () => {
  const f = fixture();
  const scopedDb = { from: (table: string) => {
    const query = f.db.from(table);
    query.update = () => { throw new Error('Browser roles cannot update file metadata'); };
    return query;
  } };
  const service = new DocumentService(scopedDb, f.storage, null, 'user-1', 'workspace-1', f.fetcher, f.db);
  assert.equal((await service.completeUpload('file-1')).processing_status, 'ready');
  assert.equal((await service.completeUpload('file-1')).processing_status, 'ready');
  assert.deepEqual(f.signed, ['HEAD']);
});

test('server writer is never reached for missing membership or an unverified object', async () => {
  const f = fixture(null, 16);
  let writes = 0;
  const writer = { from: () => { writes++; throw new Error('Unexpected write'); } };
  const denied = new DocumentService(f.db, f.storage, null, 'viewer', 'workspace-1', f.fetcher, writer);
  await assert.rejects(denied.completeUpload('file-1'), (error: any) => error.status === 403);
  assert.deepEqual(f.signed, []);
  const mismatch = new DocumentService(f.db, f.storage, null, 'user-1', 'workspace-1', f.fetcher, writer);
  await assert.rejects(mismatch.completeUpload('file-1'), (error: any) => error.status === 422);
  assert.equal(writes, 0);
});

test('upload size limit matches the production database constraint', async () => {
  const f = fixture();
  await assert.rejects(f.service.beginUpload('project-1', { name: 'large.pdf', contentType: 'application/pdf', byteSize: 50 * 1024 * 1024 + 1 }), (error: any) => error.status === 413);
  assert.deepEqual(f.signed, []);
});
