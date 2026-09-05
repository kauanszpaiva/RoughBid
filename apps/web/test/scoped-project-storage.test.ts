import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageService, persistentProject } from '../app/src/utils/storage.ts';
import type { Project } from '../app/src/types/index.ts';

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  get length() { return values.size; },
  key: (index: number) => [...values.keys()][index] ?? null,
} });
const firstScope = { userId: 'account-a', workspaceId: 'workspace-a' };
const project: Project = {
  id: 'local-one', remoteId: 'remote-one', name: 'My project', clientName: 'Client', address: 'Site',
  projectType: 'Remodel', status: 'Planning', updatedAt: 'Just now', overheadPercentage: 10, markupPercentage: 20,
  revisions: [{ id: 'revision-one', revisionNumber: '01', fileName: 'real.pdf', fileSize: '1 MB', pages: 1,
    uploadDate: '2026-09-05', uploadedBy: 'Estimator', isCurrent: true, remoteFileId: 'file-one', fileUrl: 'blob:expired',
    annotations: [{ id: 'note-one', page: 1, x: 0.25, y: 0.75, text: 'Verify footing' }] }],
  quantities: [], estimateItems: [],
};

test('projects and pending drafts are isolated by account and workspace', () => {
  values.clear();
  assert.equal(StorageService.saveProjects([project], firstScope), true);
  assert.equal(StorageService.savePendingProjects([project], firstScope), true);
  assert.equal(StorageService.getProjects(firstScope).length, 1);
  assert.equal(StorageService.getPendingProjects(firstScope).length, 1);
  assert.deepEqual(StorageService.getProjects({ ...firstScope, userId: 'account-b' }), []);
  assert.deepEqual(StorageService.getPendingProjects({ ...firstScope, workspaceId: 'workspace-b' }), []);
});

test('unscoped legacy projects and profile data are not imported into an account', () => {
  values.clear();
  values.set('roughbid_projects_v1', JSON.stringify([project]));
  values.set('roughbid_user_v1', JSON.stringify({ name: 'Other account', email: 'private@example.com' }));
  assert.deepEqual(StorageService.getProjects(firstScope), []);
  assert.notEqual(StorageService.getUserProfile(firstScope.userId).name, 'Other account');
  assert.equal(StorageService.getUserProfile().email, '');
});

test('saved revisions keep remote identity without persisting expiring file URLs', () => {
  values.clear();
  const clean = persistentProject(project);
  assert.equal(clean.revisions[0]?.remoteFileId, 'file-one');
  assert.equal(clean.revisions[0]?.fileUrl, undefined);
  assert.deepEqual(clean.revisions[0]?.annotations, project.revisions[0]?.annotations);
  assert.equal(project.revisions[0]?.fileUrl, 'blob:expired');
  StorageService.saveProjects([project], firstScope);
  assert.equal(StorageService.getProjects(firstScope)[0]?.revisions[0]?.fileUrl, undefined);
});

test('browser quota failure is reported instead of claiming a durable backup', () => {
  const original = localStorage.setItem;
  localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  try {
    assert.equal(StorageService.savePendingProjects([project], firstScope), false);
  } finally { localStorage.setItem = original; }
});

test('saving a different project cannot erase another tabs unsaved draft', () => {
  values.clear();
  const second = { ...project, id: 'local-two', remoteId: 'remote-two' };
  StorageService.savePendingProject(project.id, project, firstScope);
  StorageService.savePendingProject(second.id, second, firstScope);
  StorageService.savePendingProject(second.id, null, firstScope);
  assert.deepEqual(StorageService.getPendingProjects(firstScope).map(p => p.id), [project.id]);
});

test('acknowledging one legacy draft preserves the remaining drafts', () => {
  values.clear();
  const second = { ...project, id: 'local-two', remoteId: 'remote-two' };
  values.set('roughbid_pending_projects_v1:account-a:workspace-a', JSON.stringify([project, second]));
  StorageService.savePendingProject(project.id, null, firstScope);
  assert.deepEqual(StorageService.getPendingProjects(firstScope).map(p => p.id), [second.id]);
});
