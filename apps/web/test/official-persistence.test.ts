import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app/src/App.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../app/src/services/api.ts', import.meta.url), 'utf8');
const service = readFileSync(new URL('../../api/src/projects/service.ts', import.meta.url), 'utf8');

test('official app loads workspace projects from the backend after login', () => {
  assert.match(app, /listProjects as listRemoteProjects/);
  assert.match(app, /await listRemoteProjects\(resolved\.id\)/);
  assert.doesNotMatch(app, /StorageService\.getProjects\(\)/);
});

test('project create update and delete persist the full project state', () => {
  assert.match(app, /appState: project/);
  assert.match(app, /createRemoteProject\(workspace\.id, projectPayload/);
  assert.match(app, /updateRemoteProject\(workspace\.id, updated\.remoteId, projectPayload\(updated\)\)/);
  assert.match(app, /deleteRemoteProject\(workspace\.id, projectToDelete\.remoteId\)/);
});

test('project API exposes typed app state and validates size server-side', () => {
  assert.match(api, /app_state\?: Record<string, unknown> \| null/);
  assert.match(service, /appState must be an object/);
  assert.match(service, /250_000/);
});
