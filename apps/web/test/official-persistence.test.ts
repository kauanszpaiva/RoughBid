import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app/src/App.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../app/src/services/api.ts', import.meta.url), 'utf8');
const service = readFileSync(new URL('../../api/src/projects/service.ts', import.meta.url), 'utf8');
const storage = readFileSync(new URL('../app/src/utils/storage.ts', import.meta.url), 'utf8');
const plansPage = readFileSync(new URL('../app/src/pages/PlansPage.tsx', import.meta.url), 'utf8');
const blueprintViewer = readFileSync(new URL('../app/src/components/BlueprintViewer.tsx', import.meta.url), 'utf8');
const projectsPage = readFileSync(new URL('../app/src/pages/ProjectsPage.tsx', import.meta.url), 'utf8');

test('official app loads workspace projects from the backend after login', () => {
  assert.match(app, /listProjects as listRemoteProjects/);
  assert.match(app, /await listRemoteProjects\(resolved\.id\)/);
  assert.doesNotMatch(app, /StorageService\.getProjects\(\)/);
});

test('project create update and delete persist the full project state', () => {
  assert.match(app, /appState: stripTransientProjectState\(project\)/);
  assert.match(app, /createRemoteProject\(workspace\.id, projectPayload/);
  assert.match(app, /updateRemoteProject\(workspace\.id, updated\.remoteId, projectPayload\(updated\)\)/);
  assert.match(app, /deleteRemoteProject\(workspace\.id, projectToDelete\.remoteId\)/);
});

test('projects are not seeded or cached globally across users', () => {
  assert.match(storage, /STORAGE_KEY_PROJECT_SCOPE_PREFIX/);
  assert.match(storage, /getProjectsForScope\(scope: string\)/);
  assert.match(storage, /saveProjectsForScope\(scope: string, projects: Project\[\]\)/);
  assert.match(app, /session\.user\.id\}:\$\{resolved\.id\}/);
  assert.match(app, /StorageService\.saveProjectsForScope\(scopedCacheKey, mapped\)/);
  assert.doesNotMatch(storage, /localStorage\.setItem\(STORAGE_KEY_PROJECTS, JSON\.stringify\(INITIAL_PROJECTS\)\)/);
});

test('uploaded PDFs render as the selected plan instead of the sample blueprint', () => {
  assert.match(plansPage, /fileUrl: URL\.createObjectURL\(file\)/);
  assert.match(plansPage, /workspaceId=\{workspaceId\}/);
  assert.match(plansPage, /onEnsureProjectSynced\(project\)/);
  assert.match(plansPage, /effectiveProject\.remoteId/);
  assert.match(blueprintViewer, /getDocument/);
  assert.match(blueprintViewer, /<canvas/);
  assert.match(blueprintViewer, /Uploaded PDF/);
  assert.match(blueprintViewer, /createDocumentDownloadUrl\(workspaceId, currentRevision\.remoteFileId!\)/);
});

test('local or legacy projects are synced before private PDF upload', () => {
  assert.match(app, /handleEnsureProjectSynced/);
  assert.match(app, /if \(project\.remoteId\) return project/);
  assert.match(app, /createRemoteProject\(workspace\.id, projectPayload\(project\)\)/);
  assert.match(app, /onEnsureProjectSynced=\{handleEnsureProjectSynced\}/);
  assert.match(plansPage, /Project could not be synced to your private workspace before upload/);
});

test('workspace loading is not blocked by delayed profile bootstrap', () => {
  assert.match(app, /Profile bootstrap is delayed; continuing workspace setup/);
  assert.match(app, /const workspaces = await listWorkspaces\(\)/);
  assert.match(app, /await createWorkspace/);
  assert.match(app, /workspaceNotice=\{workspaceNotice\}/);
  assert.match(app, /isWorkspaceReady=\{workspace !== null\}/);
  assert.match(projectsPage, /workspaceNotice/);
  assert.match(projectsPage, /disabled=\{!isWorkspaceReady\}/);
});

test('workspace refresh keeps the selected project open', () => {
  assert.match(app, /setActiveProject\(current => current \? cachedProjects\.find\(project => project\.id === current\.id \|\| project\.remoteId === current\.remoteId\) \?\? current : current\)/);
  assert.match(app, /setActiveProject\(current => current \? mapped\.find\(project => project\.id === current\.id \|\| project\.remoteId === current\.remoteId\) \?\? current : current\)/);
});

test('project API exposes typed app state and validates size server-side', () => {
  assert.match(api, /app_state\?: Record<string, unknown> \| null/);
  assert.match(service, /appState must be an object/);
  assert.match(service, /250_000/);
});
