import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { isAiPlanInFlight, presentFullTakeoffCheckpoint, presentFullTakeoffStatus } from '../app/src/utils/aiPlanStatus.ts';
import type { FullTakeoffRun } from '../app/src/services/api.ts';

const plansCode = readFileSync(new URL('../app/src/pages/PlansPageContent.tsx', import.meta.url), 'utf8');
const modalCode = readFileSync(new URL('../app/src/components/AIPlanModal.tsx', import.meta.url), 'utf8');
function productionFunction(code: string, name: string, context: Record<string, unknown>) {
  const source = ts.createSourceFile('UI.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) initializer = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(initializer, `${name} exists in the production component`);
  const compiled = ts.transpileModule(`(${initializer.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  return runInNewContext(compiled, context) as (...args: any[]) => any;
}
const noop = () => {};
const run = (patch: Partial<FullTakeoffRun> = {}): FullTakeoffRun => ({
  id: 'durable-run', mode: 'full_v2', status: 'queued', progress: { completed: 0, total: 10 }, sheets: [], ...patch,
});

test('saved blocked stages do not certify coverage, measured quantities or prices', () => {
  const state = presentFullTakeoffStatus(run({ status: 'needs_review', progress: { completed: 10, total: 10 },
    output_summary: { takeoff_v2: { releaseStatus: 'blocked', budgetStatus: 'awaiting_measurement_and_price_evidence' } } }));
  assert.equal(state.finished, true);
  assert.match(state.savedProgress, /10\/10 checkpoints saved/);
  assert.match(state.notice, /unresolved blockers/);
  assert.match(state.notice, /quantities and prices are not verified/);
  assert.doesNotMatch(state.notice, /complete takeoff|released|100%/i);
  assert.equal(state.canCancel, false);
  assert.equal(state.canRestart, false);
});

test('all persisted review-ready evidence still requires human measurement and price verification', () => {
  const state = presentFullTakeoffStatus(run({ status: 'needs_review', output_summary: { takeoff_v2: { releaseStatus: 'review_ready' } } }));
  assert.match(state.notice, /human review/);
  assert.match(state.notice, /prices still require verification/);
});

test('invalid or missing progress never becomes an invented percentage or checkpoint count', () => {
  for (const progress of [null, {}, { completed: 11, total: 10 }, { completed: -1, total: 10 }, { completed: 0, total: 0 }, { completed: 1.2, total: 10 }]) {
    assert.equal(presentFullTakeoffStatus(run({ progress })).savedProgress, 'Checkpoint totals are not available yet');
  }
  assert.equal(isAiPlanInFlight('processing'), true);
  assert.equal(isAiPlanInFlight('queued'), true);
  assert.equal(isAiPlanInFlight('cancelled'), false);
});

test('resume remains unavailable until the saved sheet records exclude uncertain attempts', () => {
  assert.equal(presentFullTakeoffStatus(run({ status: 'failed', sheets: undefined })).canRestart, false);
  for (const status of ['processing', 'failed'] as const) {
    assert.equal(presentFullTakeoffStatus(run({ status: 'cancelled', sheets: [{ id: 'sheet', physical_page_number: 1, status: 'blocked', status_reason: null,
      passes: [{ plan_sheet_id: 'sheet', pass_type: 'geometry', attempt: 1, status, provider: null, model: null, failure_classification: null, started_at: null, completed_at: null }] }] })).canRestart, false);
  }
  assert.equal(presentFullTakeoffStatus(run({ status: 'cancelled' })).canRestart, true);
  assert.equal(presentFullTakeoffStatus(run({ status: 'processing', cancel_requested_at: '2026-10-02' })).canCancel, false);
});

test('checkpoint presentation preserves missing source evidence without inventing measurements', () => {
  const evidence = presentFullTakeoffCheckpoint({ observations: [
    { description: 'Wall reference requires another sheet.', source_excerpt: null },
    { description: 'Printed scale is visible.', source_excerpt: '1/4 inch = 1 foot' },
    { description: 123, source_excerpt: 'invalid' },
  ], blockers: ['Missing wall height.', null], deterministic_scale: {
    calibration: { verificationStatus: 'single_source' }, evidence: [{ sourceExcerpt: '1/4 inch = 1 foot' }],
  }, quantity: null, price: null });
  assert.deepEqual(evidence.observations.map(item => item.sourceExcerpt), [null, '1/4 inch = 1 foot']);
  assert.deepEqual(evidence.blockers, ['Missing wall height.']);
  assert.equal(evidence.scaleStatus, 'single_source');
  assert.equal('quantity' in evidence, false);
  assert.equal('price' in evidence, false);
});

function startContext(overrides: Record<string, unknown> = {}) {
  const patch: unknown[] = [], calls: unknown[] = [];
  const context: Record<string, unknown> = {
    canWrite: true, paidActionInFlight: { current: false }, isUploading: false, isStartingAi: false, isPaying: false,
    workspaceId: 'workspace', project: { remoteId: 'project', projectType: 'Residential' }, currentRevision: { id: 'revision', remoteFileId: 'file' },
    fullTakeoffV2: true, fullTakeoffV2Available: true, selectedTrades: [], contextKey: 'context', contextRef: { current: 'context' },
    setIsStartingAi: noop, setPlanNotice: noop, setNeedsAiConsent: noop, setFindings: noop,
    createFullTakeoffRun: async (...input: unknown[]) => { calls.push(input); return run(); },
    createAiPlanReading: async () => { throw new Error('Legacy reading must not run'); },
    onPatchRevision: (...input: unknown[]) => patch.push(input), presentFullTakeoffStatus, presentAiPlanStatus: noop,
    ApiError: class extends Error {}, readableApiError: (error: Error) => error.message,
    ...overrides,
  };
  return { context, patch, calls };
}

test('owner Full V2 acknowledgement saves its durable identity and mode without a quote or legacy findings', async () => {
  const fixture = startContext();
  await productionFunction(plansCode, 'handleStartFreeReading', fixture.context)();
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.calls)), [['workspace', 'project', 'file']]);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.patch)), [['revision', { aiPlanJobId: 'durable-run', aiPlanStatus: 'queued', aiPlanMode: 'full_v2' }]]);
  assert.equal((fixture.context.paidActionInFlight as { current: boolean }).current, false);
});

test('Full V2 selection cannot dispatch when this workspace is not entitled', async () => {
  const fixture = startContext({ fullTakeoffV2Available: false });
  await productionFunction(plansCode, 'handleStartFreeReading', fixture.context)();
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.patch.length, 0);
});

test('legacy paid quote continues to dispatch quick mode even if Full V2 is selected elsewhere', async () => {
  const fixture = startContext({ quoteRecoveryReady: true, readingQuote: { id: 'quote', status: 'paid', scope: 'saved scope', trades: ['Framing'] },
    getSavedReadingQuote: async () => ({ id: 'quote', status: 'paid', scope: 'saved scope', trades: ['Framing'] }),
    setReadingQuote: noop, presentAiPlanStatus: () => ({ finished: false, notice: 'queued' }),
    createAiPlanReading: async (...input: unknown[]) => { fixture.calls.push(input); return { id: 'legacy-job', status: 'queued', plan_reading_findings: [] }; },
  });
  await productionFunction(plansCode, 'handleStartAiReading', fixture.context)();
  assert.equal((fixture.calls[0] as any[])[2].mode, 'quick');
  assert.equal((fixture.patch[0] as any[])[1].aiPlanMode, 'quick');
});

test('run cancellation is an explicit single mutation despite two events before rerender', async () => {
  let resolve!: (value: unknown) => void;
  const response = new Promise(done => { resolve = done; });
  let requests = 0;
  const lock = { current: false };
  const context = { canWrite: true, workspaceId: 'workspace', jobId: 'durable-run', fullRun: run(), runActionInFlight: lock, runActionNeedsRefresh: { current: false },
    contextKey: 'same', reviewContext: { current: 'same' }, setRunAction: noop, setRunActionError: noop, setFullRun: noop, setReload: noop,
    presentFullTakeoffStatus, cancelFullTakeoffRun: () => { requests++; return response; }, restartFullTakeoffRun: () => { throw new Error('No restart'); },
    readableError: () => 'Controlled failure' };
  const action = productionFunction(modalCode, 'handleRunAction', context);
  const first = action('cancel');
  const second = action('cancel');
  assert.equal(requests, 1);
  resolve({ id: 'durable-run', status: 'cancelled' });
  await Promise.all([first, second]);
  assert.equal(lock.current, false);
});

test('an uncertain cancellation response cannot be replayed until persisted progress is read', async () => {
  let requests = 0;
  const refresh = { current: false };
  const context = { canWrite: true, workspaceId: 'workspace', jobId: 'durable-run', fullRun: run(),
    runActionInFlight: { current: false }, runActionNeedsRefresh: refresh,
    contextKey: 'same', reviewContext: { current: 'same' }, setRunAction: noop, setRunActionError: noop, setFullRun: noop, setReload: noop,
    presentFullTakeoffStatus, cancelFullTakeoffRun: async () => { requests++; throw new Error('Transport interrupted'); },
    readableError: () => 'Transport interrupted' };
  const action = productionFunction(modalCode, 'handleRunAction', context);
  await action('cancel');
  await action('cancel');
  assert.equal(requests, 1);
  assert.equal(refresh.current, true);
});

test('Full V2 saved evidence renders by physical page/pass with escaped excerpts and unresolved blockers', () => {
  const render = productionFunction(modalCode, 'renderFullRun', { React, presentFullTakeoffStatus, presentFullTakeoffCheckpoint, isAiPlanInFlight,
    Loader2: () => null, canWrite: false, runAction: null, jobError: null, runActionError: null,
    checkpoints: { '1:geometry': { checkpoint: { observations: [{ description: 'Scale evidence', source_excerpt: '<script>drawing text</script>' }], blockers: ['Wall height is absent.'] } } },
    checkpointErrors: {}, loadingCheckpoints: {}, handleLoadCheckpoint: noop,
  });
  const html = renderToStaticMarkup(render(run({ status: 'needs_review', progress: { completed: 1, total: 10 },
    sheets: [{ id: 'sheet', physical_page_number: 1, status: 'blocked', status_reason: 'Missing scale calibration.', passes: [{
      plan_sheet_id: 'sheet', pass_type: 'geometry', attempt: 1, status: 'blocked', provider: 'roughbid', model: 'deterministic-v1',
      failure_classification: null, started_at: null, completed_at: null,
    }] }], output_summary: { takeoff_v2: { releaseStatus: 'blocked' } } })));
  assert.match(html, /Physical sheet 1/);
  assert.match(html, /geometry.*blocked/);
  assert.match(html, /Wall height is absent/);
  assert.match(html, /&lt;script&gt;drawing text&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|Cancel reading|Resume from saved stages/);
  assert.match(html, /No estimate items are created/);
});

test('Full V2 polling and individual evidence reads use the durable API and legacy page selection clears the mode', () => {
  const api = readFileSync(new URL('../app/src/services/api.ts', import.meta.url), 'utf8');
  const wrapper = readFileSync(new URL('../app/src/pages/PlansPage.tsx', import.meta.url), 'utf8');
  assert.match(plansCode, /currentRevision\.aiPlanMode === 'full_v2'/);
  assert.match(plansCode, /getFullTakeoffRun\(workspaceId, jobId\)/);
  assert.match(modalCode, /isFullRun \? await getFullTakeoffRun/);
  assert.match(api, /page_number=\$\{pageNumber\}&pass_type=\$\{encodeURIComponent\(passType\)\}/);
  assert.match(wrapper, /aiPlanMode: 'quick'/);
  assert.doesNotMatch(plansCode, /setFullTakeoffV2\(value\.fullTakeoffV2\)/);
});
