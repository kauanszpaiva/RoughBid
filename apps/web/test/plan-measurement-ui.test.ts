import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { reviewMeasurement, type MeasurementScope } from '../../api/src/takeoff-v2/measurement-review.ts';
import { buildPlanMeasurementInput, draftFromSavedPlanMeasurement, emptyPlanMeasurementDraft, planPointFromPointer,
  planReferencePdfLength, planRegionFromPoints, planViewportMatches, pointInsidePlanRegion, isUsablePlanRegion,
  type PlanMeasurementDraft } from '../app/src/utils/planMeasurementReview.ts';
import { downloadVerifiedPlanPdf } from '../app/src/utils/verifiedPlanPdf.ts';
import type { PlanMeasurementContext, PlanMeasurementRow } from '../app/src/services/planmeasurements-api.ts';

const code = readFileSync(new URL('../app/src/components/PlanMeasurementPanel.tsx', import.meta.url), 'utf8');
const noop = () => {};
function productionFunction(name: string, context: Record<string, unknown>) {
  const source = ts.createSourceFile('PlanMeasurementPanel.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source); assert.ok(initializer, `${name} must exist in production UI`);
  const compiled = ts.transpileModule(`(${initializer.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  return runInNewContext(compiled, context) as (...args: any[]) => any;
}
const context: PlanMeasurementContext = { fileId: 'file', fileSha256: 'a'.repeat(64), physicalPageCount: 1,
  sheet: { physicalPageNumber: 1, pageSha256: 'b'.repeat(64), pageWidthPoints: 100, pageHeightPoints: 100,
    rotationDegrees: 0, displayWidthPoints: 100, displayHeightPoints: 100 } };
const scope: MeasurementScope = { runId: 'run', workspaceId: 'workspace', projectId: 'project', fileId: context.fileId,
  fileSha256: context.fileSha256, pageSha256: context.sheet.pageSha256, physicalPageNumber: 1, widthPoints: 100, heightPoints: 100, rotationDegrees: 0 };
const id = '40000000-0000-4000-8000-000000000001';
function draft(patch: Partial<PlanMeasurementDraft> = {}): PlanMeasurementDraft {
  return { ...emptyPlanMeasurementDraft(id), label: 'North wall segment', regionKey: 'sheet-1:north', regionBounds: [0, 0, 1, 1],
    canonicalElementKey: 'level-1:north-wall:segment-1', canonicalTrade: 'drywall', sourceExcerpt: 'North wall endpoints visible on sheet one.',
    points: [[0, 0], [1, 0]], decision: 'accepted', geometryReviewed: true, identityReviewed: true, duplicateReviewComplete: true,
    boundaryMethod: 'human_trace', boundaryReviewed: true, boundaryExcerpt: 'Endpoints follow the actual physical wall segment.',
    references: [
      { sourceId: 'dimension-A', sourceType: 'explicit_dimension', sourceExcerpt: 'Dimension A explicitly states 5 ft.', drawingLength: '5', unit: 'ft', referenceLine: [[0, 0], [0.5, 0]], independenceVerified: true },
      { sourceId: 'scale-B', sourceType: 'graphic_scale', sourceExcerpt: 'Independent graphic bar B spans 5 ft.', drawingLength: '5', unit: 'ft', referenceLine: [[0, 0.1], [0.5, 0.1]], independenceVerified: true },
    ], ...patch };
}
function row(patch: Partial<PlanMeasurementRow> = {}): PlanMeasurementRow {
  const input = buildPlanMeasurementInput(draft(), context);
  return { id, physical_page_number: 1, page_sha256: context.sheet.pageSha256, file_sha256: context.fileSha256,
    region_key: input.regionKey, region_bounds: input.regionBounds, canonical_element_key: input.canonicalElementKey, canonical_trade: input.canonicalTrade,
    label: input.label, geometry: input.geometry, source_kind: input.sourceKind, source_candidate_id: null, quantity: 10, unit: 'LF',
    calibration: { verificationStatus: 'verified' }, proof: { sourceExcerpt: input.sourceExcerpt, geometryReviewed: true,
      identityReviewed: true, duplicateReviewComplete: true, calibrationEvidence: input.calibrationEvidence, boundaryEvidence: input.boundaryEvidence! },
    uncertainty: [], review_status: 'accepted', review_revision: 1, reviewed_by: 'authenticated-user', reviewed_at: '2026-10-02', ...patch };
}

test('pointer coordinates use the actual displayed page and reject clicks outside it', () => {
  const bounds = { left: 100, top: 200, width: 500, height: 1000 };
  assert.deepEqual(planPointFromPointer(350, 700, bounds), [0.5, 0.5]);
  assert.equal(planPointFromPointer(99, 200, bounds), null);
  assert.equal(planPointFromPointer(601, 200, bounds), null);
  assert.equal(planPointFromPointer(100, 200, { ...bounds, width: 0 }), null);
  assert.equal(planPointFromPointer(Number.NaN, 200, bounds), null);
  assert.deepEqual(planRegionFromPoints([0.8, 0.9], [0.2, 0.1]), [0.2, 0.1, 0.6000000000000001, 0.8]);
  assert.equal(planRegionFromPoints([0.2, 0.1], [0.2, 0.9]), null);
  assert.equal(pointInsidePlanRegion([0.5, 0.5], [0.1, 0.1, 0.2, 0.2]), false);
});

test('review requests bind exact source hashes and omit model or manually supplied quantities', () => {
  const input = buildPlanMeasurementInput(draft(), context);
  assert.equal('quantity' in input, false); assert.equal('reviewerId' in input, false);
  assert.equal(input.fileSha256, scope.fileSha256); assert.equal(input.pageSha256, scope.pageSha256);
  assert.equal(input.calibrationEvidence[0]!.pdfPoints, 50);
  const result = reviewMeasurement(input, scope);
  assert.equal(result.quantity, 10); assert.equal(result.unit, 'LF'); assert.equal(result.humanReviewRequired, true);
});

test('actual rectangular and polygon boundaries produce deterministic reviewed areas after calibration', () => {
  const rectangle = buildPlanMeasurementInput(draft({ geometryType: 'rectangle', points: [[0, 0], [0.5, 0.5]], boundaryMethod: 'verified_rectangular_surface' }), context);
  assert.equal(reviewMeasurement(rectangle, scope).quantity, 25);
  const polygon = buildPlanMeasurementInput(draft({ geometryType: 'polygon', points: [[0, 0], [0.5, 0], [0, 0.5]] }), context);
  assert.equal(reviewMeasurement(polygon, scope).quantity, 12.5);
  assert.throws(() => buildPlanMeasurementInput(draft({ boundaryMethod: 'verified_rectangular_surface' }), context), /rectangular trace/);
});

test('scale references in meters/inches convert once and rotation uses displayed PDF dimensions', () => {
  const value = draft(); value.references[0]!.unit = 'm'; value.references[0]!.drawingLength = '1.524';
  value.references[1]!.unit = 'in'; value.references[1]!.drawingLength = '60';
  assert.equal(reviewMeasurement(buildPlanMeasurementInput(value, context), scope).quantity, 10);
  const rotated = { ...context, sheet: { ...context.sheet, pageWidthPoints: 200, pageHeightPoints: 100, rotationDegrees: 90, displayWidthPoints: 100, displayHeightPoints: 200 } };
  assert.equal(planReferencePdfLength([[0, 0], [0, 0.5]], rotated), 100);
  assert.equal(planViewportMatches(100, 200, rotated), true);
  assert.equal(planViewportMatches(200, 100, rotated), false);
  assert.equal(planViewportMatches(99, 200, rotated), false);
});

test('a saved candidate has unknown quantity and cannot become accepted through incomplete review', () => {
  const candidate = buildPlanMeasurementInput(draft({ decision: 'candidate', geometryReviewed: false, references: [], boundaryReviewed: false }), context);
  assert.equal(reviewMeasurement(candidate, scope).quantity, null);
  for (const patch of [{ references: [] }, { geometryReviewed: false }, { identityReviewed: false }, { duplicateReviewComplete: false }, { uncertainty: 'Hidden edge unresolved' }]) {
    assert.throws(() => buildPlanMeasurementInput(draft(patch), context), /Acceptance requires/);
  }
  assert.throws(() => buildPlanMeasurementInput(draft({ boundaryReviewed: false }), context), /actual measured boundary/);
});

test('server rejects repeated, inconsistent or unscoped reference evidence emitted by a draft', () => {
  const repeated = draft(); repeated.references[1] = { ...repeated.references[0]! };
  assert.throws(() => reviewMeasurement(buildPlanMeasurementInput(repeated, context), scope), /Repeated references/);
  const conflict = draft(); conflict.references[1]!.drawingLength = '15';
  assert.throws(() => reviewMeasurement(buildPlanMeasurementInput(conflict, context), scope), /two_agreeing/);
  const outside = draft({ regionBounds: [0, 0, 1, 0.5] }); outside.references[1]!.referenceLine = [[0, 0.8], [0.5, 0.8]];
  assert.throws(() => reviewMeasurement(buildPlanMeasurementInput(outside, context), scope), /in this region/);
});

test('one physical visible element requires identity/dedup review but invents no dimensional scale', () => {
  const input = buildPlanMeasurementInput(draft({ geometryType: 'point', points: [[0.2, 0.2]], references: [], boundaryReviewed: false }), context);
  assert.equal(input.sourceKind, 'manual_observed_count'); assert.deepEqual(input.calibrationEvidence, []);
  const result = reviewMeasurement(input, scope); assert.equal(result.quantity, 1); assert.equal(result.unit, 'EA');
  assert.equal(result.calibration, null); assert.equal('boundaryEvidence' in input, false);
  assert.throws(() => buildPlanMeasurementInput(draft({ geometryType: 'point', points: [[0.2, 0.2]], references: [], duplicateReviewComplete: false }), context), /Acceptance requires/);
});

test('saved audit revisions restore boundary/reference evidence without changing physical identity', () => {
  const saved = row({ review_revision: 7 });
  const restored = draftFromSavedPlanMeasurement(saved), input = buildPlanMeasurementInput(restored, context);
  assert.equal(input.expectedRevision, 7); assert.equal(input.measurementId, id);
  assert.equal(input.canonicalElementKey, saved.canonical_element_key);
  assert.deepEqual(input.boundaryEvidence, saved.proof.boundaryEvidence);
  assert.deepEqual(input.calibrationEvidence, saved.proof.calibrationEvidence);
});

test('choosing a native bbox resets traces, dimensions and approvals rather than manufacturing area', () => {
  let selected: PlanMeasurementDraft | null = null;
  const choose = productionFunction('chooseCandidate', { canWrite: true, busy: null, needsRead: { current: false }, context,
    crypto: { randomUUID: () => id }, emptyPlanMeasurementDraft, isUsablePlanRegion, setDraft: (value: PlanMeasurementDraft) => { selected = value; },
    setPendingRegionPoint: noop, setMode: noop, setNotice: noop, setError: noop });
  choose({ id: 'c'.repeat(64), pageSha256: context.sheet.pageSha256, bbox: [0.1, 0.1, 0.5, 0.5] });
  const value = selected as unknown as PlanMeasurementDraft;
  assert.deepEqual(JSON.parse(JSON.stringify(value.regionBounds)), [0.1, 0.1, 0.5, 0.5]);
  assert.equal(value.points.length, 0); assert.equal(value.references.every(reference => reference.drawingLength === ''), true);
  assert.equal(value.decision, 'candidate'); assert.equal(value.boundaryReviewed, false); assert.equal(value.identityReviewed, false);
  assert.equal('quantity' in value, false);
});

test('a zero-area native opening stays evidence and cannot become a measurement region', () => {
  let changes = 0, notice = '';
  const choose = productionFunction('chooseCandidate', { canWrite: true, busy: null, needsRead: { current: false }, context, isUsablePlanRegion,
    setDraft: () => { changes++; }, setNotice: (value: string) => { notice = value; } });
  for (const bbox of [[0.1, 0.1, 0, 0.5], [0.1, 0.1, 0.5, 0], [0.8, 0.8, 0.5, 0.5]]) {
    choose({ pageSha256: context.sheet.pageSha256, bbox });
    assert.equal(changes, 0); assert.match(notice, /Select a region.*manually/);
  }
  assert.throws(() => buildPlanMeasurementInput(draft({ regionBounds: [0.1, 0.1, 0, 0.5] }), context), /width and height/);
});

function saveFixture(overrides: Record<string, unknown> = {}) {
  const calls: unknown[] = [], lock = { current: false }, needsRead = { current: false };
  return { calls, lock, needsRead, values: { canWrite: true, context, busy: null, saveInFlight: lock, needsRead, previewReady: true,
    draft: draft(), workspaceId: 'workspace', runId: 'run', key: 'same', activeContext: { current: 'same' }, buildPlanMeasurementInput,
    setBusy: noop, setError: noop, setNotice: noop, setRows: noop, setDraft: noop, setNeedsReload: noop, draftFromSavedPlanMeasurement, message: (error: Error) => error.message,
    savePlanMeasurement: async (...args: unknown[]) => { calls.push(args); return { measurement: row() }; }, ...overrides } };
}

test('two save events issue one scoped CAS write before the response arrives', async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise(done => { resolve = done; });
  const fixture = saveFixture(); fixture.values.savePlanMeasurement = async (...args: unknown[]) => { fixture.calls.push(args); return await pending as any; };
  const save = productionFunction('handleSave', fixture.values), event = { preventDefault: noop };
  const first = save(event), second = save(event);
  assert.equal(fixture.calls.length, 1); assert.equal((fixture.calls[0] as any[])[2].expectedRevision, 0);
  resolve({ measurement: row() }); await Promise.all([first, second]); assert.equal(fixture.lock.current, false);
});

test('a lost save acknowledgement blocks blind repeats until the specific saved identity is read', async () => {
  const fixture = saveFixture(); fixture.values.savePlanMeasurement = async (...args: unknown[]) => { fixture.calls.push(args); throw new Error('Transport interrupted'); };
  const save = productionFunction('handleSave', fixture.values), event = { preventDefault: noop };
  await save(event); await save(event);
  assert.equal(fixture.calls.length, 1); assert.equal(fixture.needsRead.current, true);
  const calls: unknown[] = []; let restored: PlanMeasurementDraft | null = null;
  const reload = productionFunction('handleReload', { busy: null, saveInFlight: fixture.lock, nextOffset: null, needsRead: fixture.needsRead,
    workspaceId: 'workspace', runId: 'run', pageNumber: 1, draft: draft(), key: 'same', activeContext: { current: 'same' },
    setBusy: noop, setError: noop, setContext: noop, setRows: noop, setNextOffset: noop, setNeedsReload: noop, setNotice: noop,
    setDraft: (value: PlanMeasurementDraft) => { restored = value; }, draftFromSavedPlanMeasurement, message: () => 'failure',
    getSavedPlanMeasurement: async (...args: unknown[]) => { calls.push(args); return { measurements: [row({ review_revision: 9 })] }; },
    getPlanMeasurements: async () => ({ ...context, measurements: [], nextOffset: null }) });
  await reload(); assert.equal((calls[0] as any[])[3], id);
  assert.equal((restored as unknown as PlanMeasurementDraft).expectedRevision, 9); assert.equal(fixture.needsRead.current, false);
});

test('an unfinished/unauthorized source preview cannot submit a measurement review', async () => {
  for (const overrides of [{ canWrite: false }, { previewReady: false }]) {
    const fixture = saveFixture(overrides); await productionFunction('handleSave', fixture.values)({ preventDefault: noop });
    assert.equal(fixture.calls.length, 0);
  }
});

test('geometry overlay renders normalized traces and count markers without quantity labels', () => {
  const render = productionFunction('PlanTrace', { React, planRegionFromPoints });
  const rectangle = renderToStaticMarkup(render({ type: 'rectangle', points: [[0.1, 0.2], [0.4, 0.6]] }));
  assert.match(rectangle, /x="0.1"/); assert.match(rectangle, /vector-effect="non-scaling-stroke"/);
  assert.equal(renderToStaticMarkup(render({ type: 'polygon', points: [[0, 0], [0.5, 0], [0, 0.5]] })).includes('polygon'), true);
  assert.equal(renderToStaticMarkup(render({ type: 'point', points: [[0.3, 0.2]] })).includes('circle'), true);
  assert.equal(/SF|LF|quantity|price/.test(rectangle), false);
});

test('private PDF download passes only signed source headers and checks the exact stored fingerprint', async () => {
  const bytes = new TextEncoder().encode('%PDF-1.7\nMock private source'), hash = createHash('sha256').update(bytes).digest('hex');
  let options: RequestInit | undefined;
  const preview = { url: 'https://storage.test/private-pdf', method: 'GET' as const, headers: { 'signed-source-header': 'mock' } };
  const result = await downloadVerifiedPlanPdf(preview, hash, new AbortController().signal,
    (async (_url, init) => { options = init; return new Response(bytes); }) as typeof fetch);
  assert.deepEqual(result, bytes); assert.deepEqual(options?.headers, preview.headers); assert.equal(options?.redirect, 'error');
  await assert.rejects(downloadVerifiedPlanPdf(preview, 'c'.repeat(64), new AbortController().signal, (async () => new Response(bytes)) as typeof fetch), /revision differs/);
  await assert.rejects(downloadVerifiedPlanPdf(preview, hash, new AbortController().signal, (async () => new Response('not a PDF')) as typeof fetch), /not a PDF/);
});

test('PDF stream download enforces its bound even when content length is missing', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
  await assert.rejects(downloadVerifiedPlanPdf({ url: 'https://storage.test', method: 'GET', headers: {} }, 'a'.repeat(64), new AbortController().signal,
    (async () => new Response(stream)) as typeof fetch), /50 MB/);
  assert.equal(cancelled, true);
});
