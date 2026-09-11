import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app/src/App.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../app/src/services/api.ts', import.meta.url), 'utf8');
const service = readFileSync(new URL('../../api/src/projects/service.ts', import.meta.url), 'utf8');
const materialsPage = readFileSync(new URL('../app/src/pages/MaterialsPage.tsx', import.meta.url), 'utf8');
const assembliesPage = readFileSync(new URL('../app/src/pages/AssembliesPage.tsx', import.meta.url), 'utf8');

test('official app loads workspace projects from the backend after login', () => {
  assert.match(app, /listProjects as listRemoteProjects/);
  assert.match(app, /await listRemoteProjects\(activeWorkspace\.id\)/);
  assert.doesNotMatch(app, /StorageService\.getProjects\(\)/);
});

test('official app does not pin a real account to old validation workspaces', () => {
  assert.match(app, /newestRealWorkspace/);
  assert.match(app, /validation\|qa\|test\|synthetic/);
  assert.match(app, /saveSelectedWorkspaceId\(userId, activeWorkspace\.id\)/);
});

test('project create update and delete persist the full project state', () => {
  assert.match(app, /appState: persistentProject\(project\)/);
  assert.match(app, /createRemoteProject\(workspace\.id, projectPayload/);
  assert.match(app, /updateRemoteProject\(activeWorkspace\.id, updated\.remoteId!, projectPayload\(updated\)\)/);
  assert.match(app, /deleteRemoteProject\(workspace\.id, projectToDelete\.remoteId\)/);
});

test('project API exposes typed app state and validates size server-side', () => {
  assert.match(api, /app_state\?: Record<string, unknown> \| null/);
  assert.match(service, /appState must be an object/);
  assert.match(service, /250_000/);
});

test('materials and assemblies use the workspace catalog API as authoritative persistence', () => {
  assert.match(api, /getWorkspaceEstimatingCatalog/);
  assert.match(api, /saveWorkspaceEstimatingCatalog/);
  assert.match(materialsPage, /getWorkspaceEstimatingCatalog/);
  assert.match(materialsPage, /saveWorkspaceEstimatingCatalog/);
  assert.match(assembliesPage, /getWorkspaceEstimatingCatalog/);
  assert.match(assembliesPage, /saveWorkspaceEstimatingCatalog/);
  assert.doesNotMatch(materialsPage, /StorageService\.saveMaterials\(/);
  assert.doesNotMatch(assembliesPage, /StorageService\.saveAssemblies\(/);
});

test('catalog pages surface server loading and optimistic concurrency instead of claiming device-only persistence', () => {
  assert.match(materialsPage, /catalogRevision/);
  assert.match(assembliesPage, /catalogRevision/);
  assert.match(materialsPage, /ApiError/);
  assert.match(assembliesPage, /ApiError/);
  assert.doesNotMatch(materialsPage, /saved on this device/i);
  assert.doesNotMatch(assembliesPage, /saved on this device/i);
});
