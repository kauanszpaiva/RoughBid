import test from 'node:test';
import assert from 'node:assert/strict';
import { DocumentService, type DocumentObjectStorage } from '../src/documents/service.ts';

const upload = { name: 'plan.pdf', contentType: 'application/pdf', byteSize: 15 };
const pendingFile = {
  id: 'file-1', workspace_id: 'workspace-1', project_id: 'project-1', uploaded_by: 'user-1',
  original_name: 'plan.pdf', mime_type: 'application/pdf', byte_size: 15,
  storage_path: 'workspace-1/project-1/file-1/source.pdf', processing_status: 'uploading',
};

function fixture(initial: Record<string, unknown> | null = pendingFile, role = 'admin') {
  let row = initial ? { ...initial } : null;
  let inserts = 0;
  let reads = 0;
  let signFailure = false;
  let readFailure = false;
  const signed: Array<{ method: string; key: string; options: unknown }> = [];
  const db = { from(table: string) {
    reads++;
    const filters: Array<[string, unknown]> = [];
    let inserted: Record<string, unknown> | null = null;
    const q: any = {
      select: () => q, limit: () => q, maybeSingle: () => q, single: () => q,
      eq: (name: string, value: unknown) => { filters.push([name, value]); return q; },
      insert: (value: Record<string, unknown>) => { inserts++; inserted = value; return q; },
      then(resolve: any, reject: any) {
        if (inserted) {
          // Model the actual pilot's one-file constraint. A resume must avoid
          // this insert altogether; deleting or replacing the row is unavailable.
          if (row) return Promise.resolve({ data: null, error: { message: 'Pilot allows one PDF per project' } }).then(resolve, reject);
          row = { ...inserted };
        }
        if (table === 'project_files' && !inserted && readFailure) {
          return Promise.resolve({ data: null, error: { message: 'Database unavailable' } }).then(resolve, reject);
        }
        const target: any = table === 'workspace_members'
          ? { workspace_id: 'workspace-1', user_id: 'user-1', role }
          : table === 'projects' ? { id: 'project-1', workspace_id: 'workspace-1' } : row;
        const matches = target && filters.every(([name, value]) => target[name] === value);
        return Promise.resolve({ data: matches ? target : null, error: null }).then(resolve, reject);
      },
    };
    return q;
  } };
  const storage: DocumentObjectStorage = { async presign(method, key, options) {
    if (signFailure) throw new Error('Signing temporarily unavailable');
    signed.push({ method, key, options });
    return { method, url: 'https://storage.example/upload', headers: {}, expiresAt: '2099-01-01' };
  } };
  return { service: new DocumentService(db, storage, null, 'user-1', 'workspace-1'), db, storage, signed,
    row: () => row, inserts: () => inserts, reads: () => reads,
    failSigning: (value: boolean) => { signFailure = value; },
    failRead: () => { readFailure = true; },
  };
}

test('retry renews the same unfinished file URL without consuming another pilot file', async () => {
  const f = fixture();
  const before = structuredClone(f.row());
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await f.service.beginUpload('project-1', upload);
    assert.equal(result.file.id, 'file-1');
  }
  assert.equal(f.inserts(), 0);
  assert.deepEqual(f.row(), before);
  assert.deepEqual(f.signed, Array(2).fill({ method: 'PUT', key: pendingFile.storage_path,
    options: { contentType: 'application/pdf', expiresIn: 300, maximumSizeInBytes: 15 } }));
});

test('a signing failure after creating the row can be retried without another insert', async () => {
  const f = fixture(null);
  f.failSigning(true);
  await assert.rejects(f.service.beginUpload('project-1', upload), /Signing temporarily unavailable/);
  const created = structuredClone(f.row());
  assert.equal(f.inserts(), 1);
  f.failSigning(false);
  const retried = await f.service.beginUpload('project-1', upload);
  assert.deepEqual(retried.file, created);
  assert.equal(f.inserts(), 1);
});

test('different PDF metadata, tenant, uploader or completed status never renew an existing PUT', async () => {
  for (const changed of [
    { original_name: 'another.pdf' }, { mime_type: 'application/octet-stream' },
    { byte_size: 16 }, { uploaded_by: 'other-user' },
    { workspace_id: 'other-workspace' }, { project_id: 'other-project' },
    { processing_status: 'ready' }, { processing_status: 'queued' },
  ]) {
    const f = fixture({ ...pendingFile, ...changed });
    await assert.rejects(f.service.beginUpload('project-1', upload), /one PDF per project/);
    assert.deepEqual(f.signed, [], JSON.stringify(changed));
    assert.deepEqual(f.row(), { ...pendingFile, ...changed });
  }
});

test('viewer and another workspace are denied before file lookup or signing', async () => {
  const viewer = fixture(pendingFile, 'viewer');
  await assert.rejects(viewer.service.beginUpload('project-1', upload), (error: any) => error.status === 403);
  assert.equal(viewer.reads(), 1);
  assert.deepEqual(viewer.signed, []);
  const f = fixture();
  const other = new DocumentService(f.db, f.storage, null, 'other-user', 'other-workspace');
  await assert.rejects(other.beginUpload('project-1', upload), (error: any) => error.status === 403);
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.signed, []);
});

test('a stored path outside the matching file scope is never signed', async () => {
  const f = fixture({ ...pendingFile, storage_path: 'other-workspace/project-1/file-1/source.pdf' });
  await assert.rejects(f.service.beginUpload('project-1', upload), (error: any) => error.status === 403);
  assert.equal(f.inserts(), 0);
  assert.deepEqual(f.signed, []);
});

test('a failed pending-upload lookup cannot create an extra row or issue a token', async () => {
  const f = fixture();
  f.failRead();
  await assert.rejects(f.service.beginUpload('project-1', upload), (error: any) => error.status === 503);
  assert.equal(f.inserts(), 0);
  assert.deepEqual(f.signed, []);
});
