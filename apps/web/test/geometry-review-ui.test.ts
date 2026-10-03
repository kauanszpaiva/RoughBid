import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createGeometryApi, type GeometryCandidate } from '../app/src/services/geometry-api.ts';
import { buildGeometryReview, emptyGeometryReview, geometryPreviewPaths, geometryQuantityLabel } from '../app/src/utils/geometryReview.ts';
import { reviewIssueMessage, reviewIssueMessages } from '../app/src/utils/reviewMessages.ts';
import { budgetSourceLabel, createConstructionBudgetApi, constructionBudgetMoneySummary } from '../app/src/services/construction-budget-api.ts';

const sha = 'a'.repeat(64), candidate: GeometryCandidate = { id: 'b'.repeat(64), provider: 'kamai', sourceElementId: 'provider-object-one', label: 'Wall area', semanticClass: 'wall', measurementKind: 'area', quantity: 5.94579456, unit: 'm2', status: 'candidate',
  geometry: { type: 'Polygon', coordinates: [[[100, 200], [300, 200], [300, 400], [100, 400], [100, 200]]] }, coordinateFrame: 'provider_blueprint', physicalPageNumber: 1, fileSha256: sha, source: { jobId: 'provider-job', revision: 'provider-revision' }, reviewReasons: [], reviewRevision: 0 };
const draft = { ...emptyGeometryReview(), identityReviewed: true, geometryReviewed: true, duplicateReviewComplete: true, reviewNote: 'Reviewed this actual wall surface and excluded overlapping object polygons.' };
const code = readFileSync(new URL('../app/src/components/GeometryCandidatePanel.tsx', import.meta.url), 'utf8');
function handler(context: Record<string, unknown>) {
  const source = ts.createSourceFile('GeometryCandidatePanel.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'handleReview') initializer = node.initializer; ts.forEachChild(node, visit); }; visit(source); assert.ok(initializer);
  return runInNewContext(ts.transpileModule(`(${initializer.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
}
function fixture(overrides: Record<string, unknown> = {}) {
  const calls: any[] = [], pending = { current: null as any }, needsRead = { current: false }, lock = { current: false };
  const context = { canWrite: true, candidate, runId: 'run-one', actionLock: lock, needsRead, pending, draft, fileSha256: sha, pageNumber: 1, workspaceId: 'workspace', projectId: 'project', context: { current: 'source' }, key: 'source',
    buildGeometryReview, crypto: { randomUUID: () => 'review-request-one' }, setError() {}, setBusy() {}, setDetail() {}, setNotice() {}, setReload() {}, onManualCorrection() {},
    api: { review: async (...args: any[]) => { calls.push(args); return { candidate: { ...candidate, status: args[3].decision, reviewRevision: 1 }, replayed: false }; } }, ...overrides };
  return { calls, pending, needsRead, lock, context };
}
test('geometry API routes remain project/workspace/file/page scoped and never send file bytes or provider credentials', async () => {
  const calls: any[] = [], api = createGeometryApi(async (path, options) => { calls.push({ path, options }); return {} as any; });
  await api.capability('workspace', 'project/name'); await api.list('workspace', 'project/name', 'file/name', 2); await api.get('workspace', 'project/name', 'run/name');
  const input = buildGeometryReview(candidate, draft, 'accepted', 'request-one', sha, 1); await api.review('workspace', 'project/name', 'run/name', input);
  assert.equal(calls[1].path, '/api/projects/project%2Fname/geometry/runs?file_id=file%2Fname&physical_page_number=2');
  assert.equal(calls[3].path, '/api/projects/project%2Fname/geometry/runs/run%2Fname/review'); assert.equal(calls[3].options.workspaceId, 'workspace');
  assert.equal(calls[3].options.body, input); assert.equal('quantity' in input, false); assert.equal('unit' in input, false);
});
test('provider SI remains SI while absent values stay undetermined and provider geometry only has an inspection viewbox', () => {
  assert.match(geometryQuantityLabel(candidate), /5[.,]945795 m²/); assert.equal(geometryQuantityLabel({ quantity: null, unit: 'm2' }), 'Measurement undetermined');
  const preview = geometryPreviewPaths(candidate.geometry)!; assert.deepEqual(preview.paths[0]![0], [100, 200]);
  assert.deepEqual(Object.keys(preview).sort(), ['paths', 'viewBox']); assert.equal('quantity' in preview, false);
  assert.equal(geometryPreviewPaths({ type: 'Polygon', coordinates: [[[NaN, 1], [2, 3]]] }), null);
});
test('confirmed geometry requires reviewed identity, source frame and duplicates without user quantity override', () => {
  for (const field of ['identityReviewed', 'geometryReviewed', 'duplicateReviewComplete'] as const) assert.throws(() => buildGeometryReview(candidate, { ...draft, [field]: false }, 'accepted', 'request', sha, 1), /source geometry/);
  assert.throws(() => buildGeometryReview({ ...candidate, fileSha256: 'c'.repeat(64) }, draft, 'accepted', 'request', sha, 1), /different source/);
  assert.throws(() => buildGeometryReview({ ...candidate, physicalPageNumber: null }, draft, 'accepted', 'request', sha, 1), /unassigned page/);
  assert.throws(() => buildGeometryReview({ ...candidate, quantity: null }, draft, 'accepted', 'request', sha, 1), /measurement evidence/);
  assert.throws(() => buildGeometryReview(candidate, { ...draft, reviewNote: 'x'.repeat(1201) }, 'accepted', 'request', sha, 1), /review note/);
  const rejected = buildGeometryReview({ ...candidate, quantity: null }, draft, 'rejected', 'request', sha, 1); assert.equal(rejected.decision, 'rejected');
});
test('geometry double clicks create one CAS audit request and saved acceptance is read before another action', async () => {
  let resolve!: (value: unknown) => void; const response = new Promise(done => { resolve = done; }); const value = fixture();
  value.context.api.review = async (...args: any[]) => { value.calls.push(args); return response as any; };
  const review = handler(value.context), first = review('accepted'), second = review('accepted'); assert.equal(value.calls.length, 1);
  resolve({ candidate: { ...candidate, status: 'accepted', reviewRevision: 1 } }); await Promise.all([first, second]);
  assert.equal(value.needsRead.current, true); assert.equal(value.lock.current, false); await review('accepted'); assert.equal(value.calls.length, 1);
});
test('lost geometry receipt keeps its exact request identity and blocks blind repeats', async () => {
  const value = fixture(); value.context.api.review = async (...args: any[]) => { value.calls.push(args); throw new Error('Controlled interruption'); };
  const review = handler(value.context); await review('accepted'); await review('accepted'); assert.equal(value.calls.length, 1);
  const original = value.calls[0][3]; value.needsRead.current = false; await review('accepted');
  assert.equal(value.calls[1][3], original); assert.equal(value.pending.current.input, original);
});
test('a source-mismatched review receipt is never announced as acceptance or used for correction', async () => {
  let corrected = 0, notices = 0;
  const value = fixture({ onManualCorrection() { corrected++; }, setNotice() { notices++; }, api: { review: async () => ({ candidate: { ...candidate, id: 'another-source', status: 'rejected', reviewRevision: 1 } }) } });
  await handler(value.context)('rejected'); assert.equal(corrected, 0); assert.equal(notices, 0); assert.equal(value.needsRead.current, true);
});
test('diagnostic codes become actionable human messages with exact codes retained only in advanced records', () => {
  assert.match(reviewIssueMessage('line:documented_material_quote_required'), /documented supplier quote/);
  assert.match(reviewIssueMessage('missing_price'), /absent price remains pending/);
  assert.equal(reviewIssueMessage('The wall edge is hidden.'), 'The wall edge is hidden.');
  assert.match(reviewIssueMessage('unrecognized_machine_code'), /Additional evidence needs review/);
  assert.equal(reviewIssueMessages(['missing_price', 'line:missing_price']).length, 1);
});
test('geometry accepted measurements can enter budgets under the real geometry run without inventing prices', async () => {
  const state = { quotes: [], snapshots: [], measurements: [{ id: 'geom-measure', runId: 'geometry-job', sourceKind: 'geometry', label: candidate.label, quantity: 64, unit: 'SF', reviewStatus: 'accepted', evidenceRef: 'geometry:job:element', pageNumber: 1 }], coverage: 'partial', humanReviewRequired: true };
  const api = createConstructionBudgetApi(async () => state as any), result = await api.get('workspace', 'project');
  assert.equal(result.measurements[0]!.sourceKind, 'geometry'); assert.equal(result.measurements[0]!.runId, 'geometry-job'); assert.equal(budgetSourceLabel('geometry'), 'Geometry');
  assert.deepEqual(constructionBudgetMoneySummary({ status: 'pending', knownSubtotalUsd: 0, totalUsd: null, lines: [], missingInputs: ['missing_price'], warnings: [], trace: [] }), { knownSubtotal: null, total: null });
});
