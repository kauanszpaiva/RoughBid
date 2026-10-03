import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { reviewPhotoEvidence } from '../../api/src/photo-evidence.ts';
import { buildPhotoHumanReview, emptyPhotoPlanarDraft, emptyPhotoReviewDraft, photoPhysicalIdentity, restorePhotoReviewDraft, type PhotoReviewDraft } from '../app/src/utils/photoReview.ts';
import { planPointFromPointer } from '../app/src/utils/planMeasurementReview.ts';
import { reviewIssueMessages } from '../app/src/utils/reviewMessages.ts';
import type { PhotoObservation, PhotoSourceAsset } from '../app/src/services/photos-api.ts';

const asset: PhotoSourceAsset = { id: 'photo-one', workspaceId: 'workspace-one', projectId: 'project-one', revision: 'a'.repeat(64), sha256: 'a'.repeat(64), mimeType: 'image/jpeg', byteSize: 10, widthPixels: 640, heightPixels: 480, storageVerified: true };
const observation: PhotoObservation = { id: 'wall-one', label: 'Wall surface', proposedQuantity: 999, proposedUnit: 'SF', method: 'visual_estimate', referenceId: null, confidence: 1, uncertainty: [], regions: [{ sourceAssetId: asset.id, surfaceKey: 'surface-one', bbox: [0, 0, 1, 1] }] };
const points: Array<[number, number]> = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
function draft(patch: Partial<PhotoReviewDraft> = {}): PhotoReviewDraft {
  return { ...emptyPhotoReviewDraft(observation), disposition: 'approved', method: 'calibrated_planar_geometry', quantity: '999', unit: 'SF', calculationMethod: 'Reviewed the actual wall rectangle against two measured edges.', uncertaintyResolved: true,
    planar: { ...emptyPhotoPlanarDraft(observation, [asset]), referencePoints: points, referenceWidth: '12', referenceHeight: '10', referenceUnit: 'LF', rectangleVerified: true, lensDistortionReviewed: true,
      measurementPoints: points, measure: 'area', samePlaneReviewed: true, geometryReviewed: true }, ...patch };
}
function approved(value = draft()) {
  const request = buildPhotoHumanReview([observation], { [observation.id]: value }, () => 'reference-one', [asset]);
  const review = reviewPhotoEvidence({ workspaceId: asset.workspaceId, projectId: asset.projectId, assets: [asset], observations: [observation],
    references: request.references.map(reference => ({ ...reference, reviewerId: 'human-one' })), decisions: request.decisions.map(decision => ({ ...decision, reviewerId: 'human-one' })) });
  return { request, review };
}
function component(file: string, name: string, context: Record<string, unknown>) {
  const code = readFileSync(new URL(file, import.meta.url), 'utf8'), source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) expression = node.initializer; ts.forEachChild(node, visit); };
  visit(source); assert.ok(expression);
  return runInNewContext(ts.transpileModule(`(${expression.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText, context);
}

test('four-point photo approval submits null quantity and exact immutable source metadata; server computes 120 SF', () => {
  const { request, review } = approved();
  assert.equal(request.decisions[0]!.quantity, null);
  assert.equal(request.references[0]!.value, 12);
  assert.equal(request.references[0]!.unit, 'LF');
  assert.equal(request.decisions[0]!.planarMeasurement!.sourceSha256, asset.sha256);
  assert.equal(review.approvedMeasurements[0]!.quantity, 120);
  assert.equal(review.approvedMeasurements[0]!.measurementScope, 'reviewed_planar_region');
  assert.equal(review.approvedMeasurements[0]!.planarProofs![0]!.status, 'human_reviewed_conditional_measurement');
  assert.equal(review.planarProofs![0]!.uncertainty.automaticCertification, false);
  assert.equal(review.pricingStatus, 'missing_price'); assert.equal(review.estimate, null);
});
test('perspective corners compute a selected region deterministically without model-proposed quantity', () => {
  const value = draft(); value.planar = { ...value.planar!, referenceUnit: 'M', referenceWidth: '2', referenceHeight: '1',
    referencePoints: [[0.15, 0.1], [0.8, 0.2], [0.95, 0.85], [0.05, 0.9]], measurementPoints: [[0.15, 0.1], [0.8, 0.2], [0.95, 0.85], [0.05, 0.9]] };
  const { review } = approved(value);
  assert.equal(review.planarProofs![0]!.areaM2, 2);
  assert.equal(review.approvedMeasurements[0]!.quantity, 21.527821);
});
test('source revision or surface mismatch refuses photo review before dispatch', () => {
  for (const patch of [{ sourceSha256: 'b'.repeat(64) }, { sourceRevision: 'b'.repeat(64) }, { sourceAssetId: 'unrelated-photo' }, { surfaceKey: 'another-surface' }]) {
    const value = draft(); value.planar = { ...value.planar!, ...patch };
    assert.throws(() => approved(value), /verified photo revision/);
  }
});
test('all four physical planar confirmations and both known dimensions are required', () => {
  for (const field of ['rectangleVerified', 'lensDistortionReviewed', 'samePlaneReviewed', 'geometryReviewed'] as const) {
    const value = draft(); value.planar = { ...value.planar!, [field]: false }; assert.throws(() => approved(value), /verify the reference rectangle/);
  }
  for (const width of ['', '0', '-1', '1e2', '2 metres']) { const value = draft(); value.planar = { ...value.planar!, referenceWidth: width }; assert.throws(() => approved(value), /both known reference dimensions/); }
  assert.throws(() => approved(draft({ unit: 'EA' })), /SF, SY or SQ/);
});
test('server rejects extrapolated and crossed geometry even after human confirmations', () => {
  for (const measurementPoints of [[[0, 0], [1, 0], [1, 1], [0, 1]], [[0.2, 0.2], [0.8, 0.8], [0.8, 0.2], [0.2, 0.8]]] as Array<Array<[number, number]>>) {
    const value = draft(); value.planar = { ...value.planar!, measurementPoints };
    const { review } = approved(value); assert.equal(review.approvedMeasurements.length, 0); assert.ok(review.blockers.length);
  }
});
test('saved planar reference restores exact corners, source revision and method for explicit re-review', () => {
  const { request } = approved(), restored = restorePhotoReviewDraft(observation, request.decisions[0]!, request.references);
  assert.equal(restored.method, 'calibrated_planar_geometry'); assert.equal(restored.quantity, '');
  assert.deepEqual(restored.planar!.referencePoints, points); assert.equal(restored.planar!.sourceSha256, asset.sha256);
  const replay = buildPhotoHumanReview([observation], { [observation.id]: restored }, () => 'reference-one', [asset]);
  assert.deepEqual(replay, request);
});
test('normal photo identity is generated deterministically and never taken from a model measurement', () => {
  assert.match(photoPhysicalIdentity(observation.id), /^object:[a-f0-9]+:[a-f0-9]+:\d+$/);
  assert.equal(emptyPhotoReviewDraft(observation).objectIdentity, photoPhysicalIdentity(observation.id));
  assert.notEqual(photoPhysicalIdentity('wall-one'), photoPhysicalIdentity('wall-two'));
  assert.equal(emptyPhotoPlanarDraft(observation, [asset]).referenceWidth, '');
  assert.deepEqual(emptyPhotoPlanarDraft(observation, [asset]).measurementPoints, []);
});
test('planar review renders source-bound canvas and review conditions without client quantity entry', () => {
  const Planar = component('../app/src/components/PhotoPlanarReview.tsx', 'PhotoPlanarReview', { React, useState: React.useState, emptyPhotoPlanarDraft, planPointFromPointer });
  const html = renderToStaticMarkup(React.createElement(Planar, { observation, assets: [asset], draft: draft().planar, previews: { [asset.id]: 'blob:private-verified-source' }, onPreview() {}, onChange() {}, disabled: false }));
  assert.match(html, /Known reference width/); assert.match(html, /Mark four reference corners/); assert.match(html, /Photo calibration canvas/);
  assert.match(html, /same flat surface/); assert.match(html, /extrapolation require other evidence/); assert.doesNotMatch(html, /Reviewed quantity|value="999"/);
});
test('approved planar UI keeps proof advanced, labels conditional measurement and leaves prices pending', () => {
  const { review } = approved();
  const Evidence = component('../app/src/components/PhotoTakeoffPanel.tsx', 'PhotoRunEvidence', { React, emptyPhotoReviewDraft, reviewIssueMessages });
  const html = renderToStaticMarkup(React.createElement(Evidence, { detail: { run: { result: review }, assets: [asset], references: [], steps: [] }, previews: {}, previewErrors: {}, previewLoading: {}, onPreview() {}, canReview: false, disabled: false, drafts: {}, onDraft() {} }));
  assert.match(html, /120 SF/); assert.match(html, /Conditional planar measurement/); assert.match(html, /Statistical uncertainty has not been quantified/);
  assert.match(html, /Pricing remains missing/); assert.match(html, /Advanced measurement proof/); assert.doesNotMatch(html, /<details open|0\.00|complete budget/);
});
