import { jsPDF } from 'jspdf';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { handleApiRequest } from '../apps/api/src/http/handler.ts';

const auth = process.env.ROUGH_TEST_ACCESS_TOKEN;
if (!auth) throw Error('Use a real confirmed test session in ROUGH_TEST_ACCESS_TOKEN.');
const statePath = 'artifacts/plan-smoke-state.json';
await mkdir('artifacts', { recursive: true });
let state = {};
try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch {}
async function api(path, method = 'GET', body, workspaceId = state.workspaceId) {
  const init = { method, headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json', ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  const r = process.env.ROUGH_TEST_BASE_URL ? await fetch(process.env.ROUGH_TEST_BASE_URL + path, init) : await handleApiRequest(new Request('https://roughbid.test' + path, init));
  const data = await r.json();
  if (!r.ok) throw Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`);
  return data;
}
async function checkpoint() { await writeFile(statePath, JSON.stringify(state, null, 2)); }
const user = await api('/api/auth/bootstrap');
console.log('Authenticated API bootstrap passed.');
if (!state.workspaceId) { state.workspaceId = (await api('/api/workspaces', 'POST', { name: 'RoughBid validation' })).id; await checkpoint(); }
if (!state.projectId) {
  state.projectId = (await api('/api/projects', 'POST', { name: 'Synthetic Gemini validation - not a client bid', status: 'draft', appState: { name: 'Synthetic Gemini validation', revisions: [], quantities: [], estimateItems: [] } })).id;
  await checkpoint();
}
console.log('Workspace and private project persisted.');
const pdf = new jsPDF();
pdf.text('SYNTHETIC ROUGHBID VALIDATION - NOT A CLIENT PLAN', 10, 20);
pdf.text('Storage room. Explicit floor area: 120 SF. Doors: 2 EA.', 10, 40);
pdf.rect(20, 60, 100, 80);
pdf.text('Scale not specified. No prices provided.', 10, 160);
const bytes = Buffer.from(pdf.output('arraybuffer'));
if (!state.fileId) {
  const upload = await api(`/api/projects/${state.projectId}/documents/upload-url`, 'POST', { name: 'synthetic-plan.pdf', contentType: 'application/pdf', byteSize: bytes.length });
  const response = await fetch(upload.upload.url, { method: upload.upload.method, headers: upload.upload.headers, body: bytes });
  if (!response.ok) throw Error(`Storage upload: ${response.status} ${await response.text()}`);
  state.fileId = upload.file.id; await checkpoint();
}
const completed = await api(`/api/documents/${state.fileId}/complete`, 'POST');
assert.equal(completed.processing_status, 'ready'); assert.equal(completed.page_count, 1);
console.log('Private PDF upload and page validation passed, no Redis.');
const job = await api(`/api/projects/${state.projectId}/ai-plan-readings`, 'POST', { file_id: state.fileId, scopeMode: 'selected_scope', requestedAreas: ['Storage room'], trades: ['architectural'] });
state.jobId = job.id; await checkpoint();
const processed = await api(`/api/ai-plan-readings/${job.id}/process`, 'POST');
assert.equal(processed.status, 'needs_review');
const reading = await api(`/api/ai-plan-readings/${job.id}`);
assert.equal(reading.output_summary.human_review_required, true);
assert.equal(reading.output_summary.coverage.requested_scope_mode, 'selected_scope');
const floor = reading.plan_reading_findings.find(f => Number(f.quantity) === 120 && f.unit?.toUpperCase() === 'SF');
assert.ok(floor, 'Real Gemini output must identify the explicit 120 SF.');
const accepted = await api(`/api/ai-plan-readings/${job.id}`, 'PATCH', { finding_id: floor.id, status: 'accepted' });
assert.equal(accepted.status, 'accepted');
const project = await api(`/api/projects/${state.projectId}`);
const quantities = [{ id: `ai-${floor.id}`, itemNumber: 1, name: floor.label, quantity: Number(floor.quantity), unit: 'SF' }];
await api(`/api/projects/${state.projectId}`, 'PATCH', { appState: { ...project.app_state, quantities } });
const persisted = await api(`/api/projects/${state.projectId}`);
assert.deepEqual(persisted.app_state.quantities, quantities);
const repeated = await api(`/api/ai-plan-readings/${job.id}/process`, 'POST');
assert.equal(repeated.findingsStored, reading.plan_reading_findings.length);
console.log('Gemini reading, persisted findings, acceptance, quantities and idempotent re-read passed.');
state.verifiedAt = new Date().toISOString();
state.findings = reading.plan_reading_findings.map(({ id, finding_type, label, quantity, unit }) => ({ id, finding_type, label, quantity, unit }));
await checkpoint();
await writeFile('artifacts/synthetic-plan.pdf', bytes);
console.log(JSON.stringify({ verifiedAt: state.verifiedAt, projectId: state.projectId, jobId: state.jobId, findings: state.findings.length, reviewedQuantity: '120 SF' }));
