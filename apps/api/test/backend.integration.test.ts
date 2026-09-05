import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBackendStore, RoughBidService } from '../src/backend/service.ts';

const start = new Date('2026-01-01T00:00:00.000Z');
const active = new Date('2026-02-01T00:00:00.000Z');

function fixture() {
  const store = new MemoryBackendStore();
  const service = new RoughBidService(store);
  service.grantWorkspaceAccess('workspace-a', 'alice');
  service.grantWorkspaceAccess('workspace-b', 'bob');
  service.grantWorkspaceEntitlement('alice', start, 45);
  service.grantWorkspaceEntitlement('bob', start, 45);
  return { store, service, alice: { id: 'alice' }, bob: { id: 'bob' } };
}

test('project CRUD requires authentication and remains isolated by workspace', () => {
  const { service, alice, bob } = fixture();
  assert.throws(() => service.listProjects(null, 'workspace-a', active), /authentication/i);
  const project = service.createProject(alice, 'workspace-a', 'School renovation', active);
  assert.deepEqual(service.listProjects(alice, 'workspace-a', active), [project]);
  assert.deepEqual(service.listProjects(bob, 'workspace-b', active), []);
  assert.throws(() => service.updateProject(bob, 'workspace-b', project.id, { name: 'Stolen', status: 'active' }, active), /not found/i);
  const updated = service.updateProject(alice, 'workspace-a', project.id, { name: 'School phase 2', status: 'active' }, active);
  assert.equal(updated.status, 'active');
  service.deleteProject(alice, 'workspace-a', project.id, active);
  assert.deepEqual(service.listProjects(alice, 'workspace-a', active), []);
});

test('private plan uploads accept only non-empty PDFs up to 50 MB', () => {
  const { service, alice } = fixture();
  const project = service.createProject(alice, 'workspace-a', 'Plans', active);
  assert.throws(() => service.uploadPlan(alice, 'workspace-a', project.id, { name: 'virus.exe', mimeType: 'application/octet-stream', bytes: 20 }, active), /only pdf/i);
  assert.throws(() => service.uploadPlan(alice, 'workspace-a', project.id, { name: 'huge.pdf', mimeType: 'application/pdf', bytes: 52_428_801 }, active), /50 MB/i);
  const upload = service.uploadPlan(alice, 'workspace-a', project.id, { name: 'plans.pdf', mimeType: 'application/pdf', bytes: 4096 }, active);
  assert.equal(upload.private, true);
  assert.match(upload.path, /^workspace-a\/project-\d+\//);
});

test('calculated estimate values are persisted with inputs and tenant ownership', () => {
  const { store, service, alice } = fixture();
  const project = service.createProject(alice, 'workspace-a', 'Estimate', active);
  const estimate = service.saveEstimate(alice, 'workspace-a', project.id, {
    materialCost: 1000, laborCost: 500, equipmentCost: 100, otherCost: 50, overheadPercent: 10, markupPercent: 20,
  }, active);
  assert.equal(estimate.directCost, 1650);
  assert.equal(estimate.overheadAmount, 165);
  assert.equal(estimate.finalPrice, 2178);
  assert.deepEqual(store.estimates.get(estimate.id), estimate);
});

test('workspace entitlement uses configured duration, needs no card, and blocks access at expiration', () => {
  const { service, alice } = fixture();
  const access = service.grantWorkspaceEntitlement(alice.id, start, 45);
  assert.equal(access.expiresAt.getTime() - access.startsAt.getTime(), 45 * 24 * 60 * 60 * 1000);
  assert.equal(access.requiresPaymentMethod, false);
  service.createProject(alice, 'workspace-a', 'Before expiry', new Date(access.expiresAt.getTime() - 1));
  assert.throws(() => service.createProject(alice, 'workspace-a', 'At expiry', access.expiresAt), /entitlement/i);
});
