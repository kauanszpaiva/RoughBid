import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { reviewPhotoEvidence, PHOTO_ASSET_LIMITS } from '../../api/src/photo-evidence.ts';
import { buildPhotoHumanReview, canResumePhotoRun, emptyPhotoReviewDraft, isPhotoRunInFlight, photoCheckpointProgress,
  PHOTO_UPLOAD_LIMITS, photoReadingSteps, photoCapacityWait, validatePhotoSelection, type PhotoReviewDraft } from '../app/src/utils/photoReview.ts';
import type { PhotoObservation, PhotoRun, PhotoRunDetail, PhotoSourceAsset } from '../app/src/services/photos-api.ts';
import { reviewIssueMessages } from '../app/src/utils/reviewMessages.ts';
import { ApiError } from '../app/src/services/authenticatedFetch.ts';

const code = readFileSync(new URL('../app/src/components/PhotoTakeoffPanel.tsx', import.meta.url), 'utf8');
function productionFunction(name: string, context: Record<string, unknown>) {
  const source = ts.createSourceFile('PhotoTakeoffPanel.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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
const noop = () => {};
const asset = (id = 'photo-one', suffix = 'a'): PhotoSourceAsset => ({ id, workspaceId: 'workspace-one', projectId: 'project-one',
  revision: suffix.repeat(64), sha256: suffix.repeat(64), mimeType: 'image/jpeg', byteSize: 10, widthPixels: 640, heightPixels: 480, storageVerified: true });
const observation = (patch: Partial<PhotoObservation> = {}): PhotoObservation => ({
  id: 'observation-one', label: 'Wall surface', proposedQuantity: null, proposedUnit: null, method: 'visual_estimate', referenceId: null,
  confidence: 0.99, uncertainty: ['physical_dimension_reference_required'],
  regions: [{ sourceAssetId: 'photo-one', surfaceKey: 'wall-one', bbox: [0.1, 0.2, 0.3, 0.4] }], ...patch,
});
const photoRun = (patch: Partial<PhotoRun> = {}): PhotoRun => ({ id: 'run-one', status: 'queued', progress: { completed: 0, total: 1 }, result: null, ...patch });
const detail = (patch: Partial<PhotoRunDetail> = {}): PhotoRunDetail => ({ run: photoRun(), assets: [asset()], references: [], steps: [], ...patch });
const approvedDraft = (patch: Partial<PhotoReviewDraft> = {}): PhotoReviewDraft => ({
  disposition: 'approved', method: 'instrument_measurement', quantity: '20', unit: 'SF', objectIdentity: 'physical-wall-one',
  calculationMethod: 'Area reading checked on the identified wall using an instrument.', verifiedReading: true,
  uncertaintyResolved: true, crossViewIdentityReviewed: false, ...patch,
});

test('photo selection follows server mime, count and batch bounds before any upload', () => {
  assert.equal(PHOTO_UPLOAD_LIMITS.maximumAssets, PHOTO_ASSET_LIMITS.maximumAssets);
  assert.equal(PHOTO_UPLOAD_LIMITS.maximumAssetBytes, PHOTO_ASSET_LIMITS.maximumAssetBytes);
  assert.equal(PHOTO_UPLOAD_LIMITS.maximumBatchBytes, PHOTO_ASSET_LIMITS.maximumBatchBytes);
  const photo = { name: 'photo.jpg', type: 'image/jpeg', size: 1024 };
  assert.equal(validatePhotoSelection([photo]), null);
  assert.match(validatePhotoSelection([])!, /one to eight/);
  assert.match(validatePhotoSelection(Array(9).fill(photo))!, /one to eight/);
  for (const type of ['application/pdf', 'image/gif', 'image/svg+xml', '']) assert.match(validatePhotoSelection([{ ...photo, type }])!, /JPEG, PNG or WebP/);
  assert.match(validatePhotoSelection([{ ...photo, size: 0 }])!, /1 byte and 20 MB/);
  assert.match(validatePhotoSelection([{ ...photo, size: 20 * 1024 * 1024 + 1 }])!, /20 MB/);
  assert.match(validatePhotoSelection(Array(3).fill({ ...photo, size: 20 * 1024 * 1024 }))!, /40 MB/);
});

test('model quantity/confidence never prefill or approve a human physical measurement', () => {
  const item = observation({ proposedQuantity: 999, proposedUnit: 'SF' });
  assert.equal(emptyPhotoReviewDraft(item).quantity, '');
  assert.equal(emptyPhotoReviewDraft(item).unit, '');
  assert.equal(emptyPhotoReviewDraft(item).disposition, 'unreviewed');
  assert.throws(() => buildPhotoHumanReview([item], {}, () => 'reference-one'), /at least one/);
  assert.throws(() => buildPhotoHumanReview([item], { [item.id]: approvedDraft({ quantity: '' }) }, () => 'reference-one'), /reviewed quantity/);
  assert.throws(() => buildPhotoHumanReview([item], { [item.id]: approvedDraft({ verifiedReading: false }) }, () => 'reference-one'), /confirm a positive instrument reading/);
});

test('instrument approval binds a separately entered reading to the source region and validates server-side', () => {
  const item = observation();
  const input = buildPhotoHumanReview([item], { [item.id]: approvedDraft() }, () => 'reference-one');
  assert.equal(input.references[0]!.region.sourceAssetId, 'photo-one');
  assert.equal(input.references[0]!.region.surfaceKey, 'wall-one');
  assert.equal(input.references[0]!.value, 20);
  assert.equal(input.references[0]!.kind, 'instrument_reading');
  assert.equal('reviewerId' in input.references[0]!, false);
  assert.equal('reviewerId' in input.decisions[0]!, false);
  const reviewed = reviewPhotoEvidence({ workspaceId: 'workspace-one', projectId: 'project-one', assets: [asset()], observations: [item],
    references: input.references.map(reference => ({ ...reference, reviewerId: 'authenticated-user' })),
    decisions: input.decisions.map(decision => ({ ...decision, reviewerId: 'authenticated-user' })) });
  assert.equal(reviewed.approvedMeasurements[0]!.quantity, 20);
  assert.equal(reviewed.pricingStatus, 'missing_price');
  assert.equal(reviewed.estimate, null);
});

test('human visible counts require whole EA and do not manufacture a scale reference', () => {
  const item = observation({ method: 'visible_count', proposedQuantity: 5, proposedUnit: 'EA' });
  const input = buildPhotoHumanReview([item], { [item.id]: approvedDraft({ method: 'visible_count', quantity: '4', unit: 'EA', verifiedReading: false }) }, () => { throw new Error('No dimension reference for counts'); });
  assert.equal(input.decisions[0]!.quantity, 4);
  assert.equal(input.references.length, 0);
  for (const patch of [{ quantity: '4.5' }, { unit: 'SF' }]) assert.throws(() => buildPhotoHumanReview([item], { [item.id]: approvedDraft({ method: 'visible_count', quantity: '4', unit: 'EA', ...patch }) }, () => 'unused'), /whole EA/);
});

test('zero is accepted only as an explicitly entered count and never replaces absent dimensions', () => {
  const item = observation();
  assert.throws(() => buildPhotoHumanReview([item], { [item.id]: approvedDraft({ quantity: '0' }) }, () => 'reference-one'), /positive instrument/);
  const count = buildPhotoHumanReview([item], { [item.id]: approvedDraft({ method: 'visible_count', unit: 'EA', quantity: '0' }) }, () => 'unused');
  assert.equal(count.decisions[0]!.quantity, 0);
});

test('multiple photos of one physical object require explicit identity review and do not double a quantity', () => {
  const first = observation({ method: 'visible_count', proposedQuantity: 4, proposedUnit: 'EA', uncertainty: [] });
  const second = observation({ id: 'observation-two', method: 'visible_count', proposedQuantity: 4, proposedUnit: 'EA', uncertainty: [],
    regions: [{ sourceAssetId: 'photo-two', surfaceKey: 'wall-two', bbox: [0.1, 0.2, 0.3, 0.4] }] });
  const draft = approvedDraft({ method: 'visible_count', unit: 'EA', quantity: '4', verifiedReading: false });
  assert.throws(() => buildPhotoHumanReview([first, second], { [first.id]: draft, [second.id]: draft }, () => 'unused'), /same physical object/);
  const input = buildPhotoHumanReview([first, second], { [first.id]: { ...draft, crossViewIdentityReviewed: true }, [second.id]: { ...draft, crossViewIdentityReviewed: true } }, () => 'unused');
  assert.deepEqual(input.decisions[0]!.identityAssetIds, ['photo-one', 'photo-two']);
  const reviewed = reviewPhotoEvidence({ workspaceId: 'workspace-one', projectId: 'project-one', assets: [asset(), asset('photo-two', 'b')], observations: [first, second],
    references: [], decisions: input.decisions.map(decision => ({ ...decision, reviewerId: 'authenticated-user' })) });
  assert.equal(reviewed.approvedMeasurements.length, 1);
  assert.equal(reviewed.approvedMeasurements[0]!.quantity, 4);
});

test('unresolved uncertainty and invented object identity cannot approve photo quantities', () => {
  for (const patch of [{ uncertaintyResolved: false }, { objectIdentity: '' }, { objectIdentity: 'wall label with spaces' }, { calculationMethod: '' }]) {
    assert.throws(() => buildPhotoHumanReview([observation()], { 'observation-one': approvedDraft(patch) }, () => 'reference-one'), /identify the physical object/);
  }
});

test('photo resume is unavailable for uncertain outcomes or live provider attempts', () => {
  assert.equal(canResumePhotoRun(detail({ run: photoRun({ status: 'blocked', error_code: 'unknown_provider_outcome' }) })), false);
  assert.equal(canResumePhotoRun(detail({ run: photoRun({ status: 'cancelled', reconciliation_required: true }) })), false);
  assert.equal(canResumePhotoRun(detail({ steps: [{ photo_asset_id: 'photo-one', status: 'processing' }] })), false);
  assert.equal(canResumePhotoRun(detail({ run: photoRun({ status: 'processing' }) })), false);
  assert.equal(canResumePhotoRun(detail({ run: photoRun({ status: 'waiting_budget' }) })), false);
  assert.equal(canResumePhotoRun(detail({ run: photoRun({ status: 'blocked', error_code: 'processing_review_required' }) })), false);
  assert.equal(canResumePhotoRun(detail({ run: photoRun({ status: 'cancelled' }) })), true);
  assert.equal(isPhotoRunInFlight('queued'), true);
  assert.equal(isPhotoRunInFlight('needs_review'), false);
  assert.equal(photoCheckpointProgress(detail()), '0/1 photo checkpoints saved');
  assert.equal(photoCheckpointProgress(detail({ run: photoRun({ progress: null }) })), 'Saved progress is not available yet');
  assert.equal(photoCheckpointProgress(detail({ run: photoRun({ progress: { completed: 2, total: 1 } }) })), 'Saved progress is not available yet');
});

test('three photo stages require saved coverage of every source and capacity waiting never becomes completion', () => {
  const saved = detail({ assets: [asset(), asset('photo-two')], run: photoRun({ status: 'waiting_budget', not_before: '2099-01-01T00:00:00Z' }),
    stageCheckpoints: [{ operation_key: 'observation:one', stage: 'observation', asset_ids: ['photo-one'], status: 'completed', completed_at: '2026-10-03T00:00:00Z' }] });
  assert.deepEqual(photoReadingSteps(saved).map(value => value.status), ['Pending', 'Pending', 'Pending']);
  saved.stageCheckpoints!.push({ operation_key: 'observation:two', stage: 'observation', asset_ids: ['photo-two'], status: 'completed', completed_at: '2026-10-03T00:00:00Z' });
  assert.deepEqual(photoReadingSteps(saved).map(value => value.status), ['Completed', 'Pending', 'Pending']);
  assert.equal(isPhotoRunInFlight(saved.run.status), true);
  assert.match(photoCapacityWait(saved)!.message, /automatically/); assert.ok(photoCapacityWait(saved)!.estimate);
  saved.run.not_before = 'unknown'; assert.equal(photoCapacityWait(saved)!.estimate, null);
  saved.run.status = 'needs_review'; assert.equal(photoCapacityWait(saved), null);
});

function startFixture(overrides: Record<string, unknown> = {}) {
  const calls: unknown[] = [], lock = { current: false }, key = { current: null as string | null }, savedId = { current: null as string | null };
  const context: Record<string, unknown> = { canWrite: true, capability: { enabled: true, ownerAccess: true, includedAvailable: true, workerReady: true }, workspaceId: 'workspace', projectId: 'project', ApiError, setNeedsConsent: noop,
    actionLock: lock, needsRead: { current: false }, acknowledgedRun: savedId, selection: [{ asset: asset() }], requestKey: key,
    crypto: { randomUUID: () => 'stable-request-key' }, contextKey: 'same', context: { current: 'same' }, loadedDraftRun: { current: null },
    setRunId: noop, setDetail: noop, setDrafts: noop, setHistory: noop, setNotice: noop, setRefresh: noop, setBusy: noop, setActionError: noop,
    createPhotoRun: async (...args: unknown[]) => { calls.push(args); return { run: photoRun(), enqueued: true }; }, message: () => 'Controlled transport interruption', ...overrides };
  return { calls, lock, key, savedId, context };
}

test('photo start acknowledges one durable identity and reopening it does not start a new provider job', async () => {
  const fixture = startFixture();
  const start = productionFunction('handleStart', fixture.context);
  await start(); assert.equal(fixture.calls.length, 0, 'Included access never implies user consent');
  await start(true); await start(true);
  assert.equal(fixture.calls.length, 1);
  assert.equal((fixture.calls[0] as any[])[2].requestKey, 'stable-request-key');
  assert.equal((fixture.calls[0] as any[])[2].consentConfirmed, true);
  assert.equal(fixture.savedId.current, 'run-one');
});

test('lost photo-start acknowledgement keeps its request key and blocks retry until saved state is read', async () => {
  const fixture = startFixture();
  fixture.context.createPhotoRun = async (...args: unknown[]) => { fixture.calls.push(args); throw new Error('Network interrupted'); };
  const start = productionFunction('handleStart', fixture.context);
  await start(true); await start(true);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.key.current, 'stable-request-key');
  assert.equal((fixture.context.needsRead as { current: boolean }).current, true);
  (fixture.context.needsRead as { current: boolean }).current = false; // A confirmed metadata read.
  await start(true);
  assert.equal((fixture.calls[1] as any[])[2].requestKey, 'stable-request-key');
});

test('a second photo action before rerender cannot dispatch another expensive request', async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise(done => { resolve = done; });
  const fixture = startFixture();
  fixture.context.createPhotoRun = (...args: unknown[]) => { fixture.calls.push(args); return pending; };
  const start = productionFunction('handleStart', fixture.context);
  const first = start(true), second = start(true);
  assert.equal(fixture.calls.length, 1);
  resolve({ run: photoRun(), enqueued: true });
  await Promise.all([first, second]);
  assert.equal(fixture.lock.current, false);
});

test('viewer, disabled provider and missing worker prevent photo dispatch', async () => {
  for (const override of [{ canWrite: false }, { capability: { enabled: false, includedAvailable: true, workerReady: true } },
    { capability: { enabled: true, ownerAccess: true, purchaseAvailable: true, includedAvailable: false, workerReady: true } }, { capability: { enabled: true, includedAvailable: true, workerReady: false } }]) {
    const fixture = startFixture(override);
    await productionFunction('handleStart', fixture.context)(true);
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.lock.current, false);
  }
});

test('private photo upload sends bytes only to the signed storage URL then verifies metadata', async () => {
  const file = { name: 'source.jpg', type: 'image/jpeg', size: 10 };
  const calls: Array<{ kind: string; args: any[] }> = [];
  const context = { canWrite: true, capability: { enabled: true, purchaseAvailable: true }, workspaceId: 'workspace', projectId: 'project', actionLock: { current: false }, needsRead: { current: false },
    selection: [{ file, status: 'selected' }], validatePhotoSelection, setActionError: noop, setBusy: noop, setSelection: noop, setNotice: noop,
    contextKey: 'same', context: { current: 'same' }, AbortSignal,
    beginPhotoUpload: async (...args: unknown[]) => { calls.push({ kind: 'reserve', args }); return { asset: { id: 'photo-one' }, upload: { url: 'https://private-storage.invalid/photo', method: 'PUT', headers: { 'content-type': 'image/jpeg' } } }; },
    fetch: async (...args: unknown[]) => { calls.push({ kind: 'storage', args }); return { ok: true }; },
    completePhotoUpload: async (...args: unknown[]) => { calls.push({ kind: 'verify', args }); return { asset: asset() }; }, message: () => 'Controlled failure' };
  await productionFunction('handleUpload', context)();
  assert.deepEqual(calls.map(call => call.kind), ['reserve', 'storage', 'verify']);
  assert.equal(calls[1]!.args[0], 'https://private-storage.invalid/photo');
  assert.equal(calls[1]!.args[1].body, file);
  assert.equal(calls[1]!.args[1].redirect, 'error');
});

test('uncertain photo cancellation is not replayed without first reading persisted state', async () => {
  let calls = 0;
  const needsRead = { current: false };
  const context = { canWrite: true, workspaceId: 'workspace', projectId: 'project', detail: detail(), actionLock: { current: false }, needsRead,
    capability: { workerReady: true }, contextKey: 'same', context: { current: 'same' }, isPhotoRunInFlight, canResumePhotoRun,
    setBusy: noop, setActionError: noop, setRefresh: noop, message: () => 'Uncertain acknowledgement',
    cancelPhotoRun: async () => { calls++; throw new Error('Transport interrupted'); } };
  const cancel = productionFunction('handleRunAction', context);
  await cancel('cancel'); await cancel('cancel');
  assert.equal(calls, 1); assert.equal(needsRead.current, true);
});

test('saved photo evidence renders null quantities as undetermined, real regions, quality and missing prices', () => {
  const item = observation({ label: '<script>source text</script>' });
  const review = reviewPhotoEvidence({ workspaceId: 'workspace-one', projectId: 'project-one', assets: [asset()], observations: [item], references: [], decisions: [] });
  const saved = detail({ run: photoRun({ status: 'needs_review', result: { ...review, independentReview: 'pending',
    stageStatus: { observation: 'completed', reconciliation: 'pending', risk_review: 'pending' },
    photoQuality: [{ sourceAssetId: 'photo-one', usable: false, additionalViewsNeeded: true, limitations: ['Wall edge is hidden.'] }] } }),
    steps: [{ photo_asset_id: 'photo-one', status: 'completed' }] });
  const render = productionFunction('PhotoRunEvidence', { React, emptyPhotoReviewDraft, reviewIssueMessages });
  const html = renderToStaticMarkup(render({ detail: saved, previews: { 'photo-one': 'blob:private-source' }, previewErrors: {}, previewLoading: {}, onPreview: noop,
    canReview: false, disabled: false, drafts: {}, onDraft: noop }));
  assert.match(html, /Physical quantity is undetermined/);
  assert.match(html, /Independent review: pending/);
  assert.match(html, /Pricing: missing source prices/);
  assert.match(html, /Wall edge is hidden/);
  assert.match(html, /left:10%;top:20%;width:30%;height:40%/);
  assert.match(html, /&lt;script&gt;source text&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|0 SF|Review decision/);
});

test('photo proposals are labeled unverified and human review requires separate quantity input', () => {
  const item = observation({ method: 'visible_count', proposedQuantity: 3, proposedUnit: 'EA', uncertainty: [] });
  const review = reviewPhotoEvidence({ workspaceId: 'workspace-one', projectId: 'project-one', assets: [asset()], observations: [item], references: [], decisions: [] });
  const render = productionFunction('PhotoRunEvidence', { React, emptyPhotoReviewDraft, reviewIssueMessages });
  const html = renderToStaticMarkup(render({ detail: detail({ run: photoRun({ status: 'needs_review', result: review }) }), previews: {}, previewErrors: {}, previewLoading: {}, onPreview: noop,
    canReview: true, disabled: false, drafts: { [item.id]: approvedDraft({ method: 'visible_count', quantity: '', unit: 'EA' }) }, onDraft: noop }));
  assert.match(html, /Unverified proposal: 3 EA/);
  assert.match(html, /Reviewed quantity/);
  assert.match(html, /placeholder="Enter a reading" value=""/);
  assert.match(html, /No estimate items or price totals/);
});

test('photo API remains project/workspace scoped and photo panel never mutates PDF revision identities', () => {
  const api = readFileSync(new URL('../app/src/services/photos-api.ts', import.meta.url), 'utf8');
  const plans = readFileSync(new URL('../app/src/pages/PlansPageContent.tsx', import.meta.url), 'utf8');
  assert.match(api, /\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}\/photos/);
  assert.match(api, /requestKey: string/);
  assert.match(plans, /<PhotoTakeoffPanel key=/);
  assert.doesNotMatch(code, /onPatchRevision|aiPlanJobId|quote_id|payForReading|quantity \?\? 0/);
  assert.match(code, /setTimeout\(poll, 4000\)/);
  assert.match(code, /requestKey\.current \? runs\.value\.runs\.find/);
});

function reviewFixture(overrides: Record<string, unknown> = {}) {
  const calls: unknown[] = [], pendingReview = { current: null as any }, needsRead = { current: false }, reviewNeedsRead = { current: false };
  let generated = 0;
  const value: Record<string, unknown> = { canWrite: true, workspaceId: 'workspace', projectId: 'project',
    detail: detail({ run: photoRun({ id: 'run-one', status: 'needs_review', review_revision: 0,
      result: { observations: [observation()], approvedMeasurements: [], blockers: [], humanReviewRequired: true, releaseStatus: 'blocked', pricingStatus: 'missing_price', estimate: null } }) }),
    drafts: { 'observation-one': approvedDraft() }, actionLock: { current: false }, needsRead, reviewNeedsRead, pendingReview,
    buildPhotoHumanReview, crypto: { randomUUID: () => `40000000-0000-4000-8000-${String(++generated).padStart(12, '0')}` },
    contextKey: 'same', context: { current: 'same' }, selectedRun: { current: 'run-one' },
    setBusy: noop, setActionError: noop, setDetail: noop, setNotice: noop, setRefresh: noop, message: (error: Error) => error.message,
    savePhotoReview: async (...args: unknown[]) => { calls.push(args); return { review: {}, reviewRevision: 1, reused: false }; }, ...overrides };
  return { calls, pendingReview, needsRead, reviewNeedsRead, value };
}

test('human photo review submits the observed revision and one stable UUID instead of an unguarded overwrite', async () => {
  const fixture = reviewFixture(); await productionFunction('handleReview', fixture.value)();
  assert.equal(fixture.calls.length, 1);
  const input = (fixture.calls[0] as any[])[3];
  assert.equal(input.expectedReviewRevision, 0); assert.match(input.reviewRequestKey, /^[a-f0-9-]{36}$/i);
  assert.equal(input.references[0].value, 20); assert.equal('reviewerId' in input.references[0], false);
  assert.equal(fixture.pendingReview.current, null);
  assert.equal(fixture.needsRead.current, true); assert.equal(fixture.reviewNeedsRead.current, true);
});

test('lost photo review acknowledgement preserves its exact payload and reference IDs until a confirmed retry', async () => {
  const fixture = reviewFixture(); fixture.value.savePhotoReview = async (...args: unknown[]) => { fixture.calls.push(args); throw new Error('Lost acknowledgement'); };
  const review = productionFunction('handleReview', fixture.value);
  await review(); await review(); assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.needsRead.current, true);
  fixture.needsRead.current = false; fixture.reviewNeedsRead.current = false; // GET confirms the same stored revision.
  await review(); assert.equal(fixture.calls.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.calls[0])), JSON.parse(JSON.stringify(fixture.calls[1])));
});

test('a confirmed newer photo revision creates a new CAS identity and unknown revisions block writes', async () => {
  const fixture = reviewFixture(); fixture.value.savePhotoReview = async (...args: unknown[]) => { fixture.calls.push(args); throw new Error('Conflict'); };
  const review = productionFunction('handleReview', fixture.value);
  await review(); const oldKey = (fixture.calls[0] as any[])[3].reviewRequestKey;
  (fixture.value.detail as PhotoRunDetail).run.review_revision = 9;
  fixture.needsRead.current = false; fixture.reviewNeedsRead.current = false; // GET observed concurrent revision nine.
  await review(); const next = (fixture.calls[1] as any[])[3];
  assert.equal(next.expectedReviewRevision, 9); assert.notEqual(next.reviewRequestKey, oldKey);
  const unknown = reviewFixture(); delete (unknown.value.detail as PhotoRunDetail).run.review_revision;
  await productionFunction('handleReview', unknown.value)(); assert.equal(unknown.calls.length, 0);
});

test('concurrent photo review clicks cannot create two audit writes before rerender', async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise(done => { resolve = done; });
  const fixture = reviewFixture(); fixture.value.savePhotoReview = async (...args: unknown[]) => { fixture.calls.push(args); return pending; };
  const review = productionFunction('handleReview', fixture.value), first = review(), second = review();
  assert.equal(fixture.calls.length, 1);
  resolve({ review: {}, reviewRevision: 1, reused: false }); await Promise.all([first, second]);
});

test('saved per-photo evidence is read lazily once and a stale result cannot replace another selected run', async () => {
  const calls: unknown[] = [], results: unknown[] = [], selectedRun = { current: 'run-one' };
  let resolve!: (value: unknown) => void;
  const pending = new Promise(done => { resolve = done; });
  const values = { workspaceId: 'workspace', projectId: 'project', runId: 'run-one', detail: detail(),
    checkpointRequests: { current: new Set<string>() }, contextKey: 'same', context: { current: 'same' }, selectedRun,
    setCheckpointLoading: noop, setCheckpointErrors: noop, setCheckpoints: (value: unknown) => results.push(value), message: () => 'failure',
    getPhotoCheckpoint: async (...args: unknown[]) => { calls.push(args); return pending; } };
  const read = productionFunction('handleCheckpoint', values);
  const first = read('photo-one'), second = read('photo-one'); await read('not-a-run-asset');
  assert.equal(calls.length, 1); assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['workspace', 'project', 'run-one', 'photo-one']);
  selectedRun.current = 'another-run'; resolve({ runId: 'run-one', photo_asset_id: 'photo-one', status: 'completed', checkpoint: null });
  await Promise.all([first, second]); assert.equal(results.length, 0);
});

test('intermediate photo checkpoint renders saved limitations and never certifies unreviewed geometry', () => {
  const render = productionFunction('PhotoRunEvidence', { React, emptyPhotoReviewDraft, reviewIssueMessages });
  const html = renderToStaticMarkup(render({ detail: detail({ run: photoRun({ status: 'blocked' }) }), previews: {}, previewErrors: {}, previewLoading: {},
    onPreview: noop, canReview: false, disabled: false, drafts: {}, onDraft: noop, onCheckpoint: noop, checkpointErrors: {}, checkpointLoading: {},
    checkpoints: { 'photo-one': { runId: 'run-one', photo_asset_id: 'photo-one', status: 'completed', asset: asset(), checkpoint: {
      observations: [observation({ label: '<script>Wall</script>' })], quality: { usable: true, limitations: ['Back side hidden'], additionalViewsNeeded: true },
      blockers: ['physical_scale_missing'], independentReview: 'pending' } } } }));
  assert.match(html, /Saved checkpoint for this photo/); assert.match(html, /quantity undetermined/);
  assert.match(html, /Back side hidden/); assert.match(html, /Review the physical scale using supported source references/); assert.match(html, /Independent review remains pending/);
  assert.match(html, /Advanced checkpoint diagnostics/); assert.match(html, /physical_scale_missing/);
  assert.equal(html.includes('<script>Wall</script>'), false);
});

test('photo coverage shows saved progress, missing views and only the needed measurement reference without a finished estimate', () => {
  const first = observation(), count = observation({id:'count',label:'Visible doors',method:'visible_count',proposedQuantity:2,proposedUnit:'EA'});
  const saved = detail({run:photoRun({status:'needs_review',result:{observations:[first,count],approvedMeasurements:[],blockers:[],humanReviewRequired:true,
    releaseStatus:'blocked',pricingStatus:'missing_price',estimate:null}}),coverage:{version:'photo-evidence-v1',totalAssets:1,processedAssetIds:['photo-one'],pendingAssetIds:[],
      unassessedAssetIds:[],unusableAssetIds:[],additionalViewAssetIds:['photo-one'],unresolvedObservationIds:[first.id,count.id],referenceRequiredObservationIds:[first.id],
      processingComplete:true,completeTakeoffVerified:false,estimateStatus:'pending'}});
  const render = productionFunction('PhotoRunEvidence',{React,emptyPhotoReviewDraft,reviewIssueMessages});
  const html = renderToStaticMarkup(render({detail:saved,previews:{},previewErrors:{},previewLoading:{},onPreview:noop,canReview:false,disabled:false,drafts:{},onDraft:noop}));
  assert.match(html,/1\/1 photos processed/);
  assert.match(html,/Add another view/);
  assert.match(html,/Estimate pending/);
  assert.match(html,/quantity stays undetermined/);
  assert.equal((html.match(/Add a verified measurement or mark a rectangle/g)??[]).length,1);
  assert.doesNotMatch(html,/0 SF|estimate complete|budget complete/i);
});
