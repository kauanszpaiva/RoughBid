import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app/src/App.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../app/src/services/api.ts', import.meta.url), 'utf8');
const service = readFileSync(new URL('../../api/src/projects/service.ts', import.meta.url), 'utf8');

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
  assert.match(app, /updateRemoteProject\(resolved\.id, updated\.remoteId!, projectPayload\(updated\)\)/);
  assert.match(app, /deleteRemoteProject\(workspace\.id, projectToDelete\.remoteId\)/);
});

test('project API exposes typed app state and validates size server-side', () => {
  assert.match(api, /app_state\?: Record<string, unknown> \| null/);
  assert.match(service, /appState must be an object/);
  assert.match(service, /250_000/);
});
