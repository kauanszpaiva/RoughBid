import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { isAiPlanInFlight, presentFullTakeoffCheckpoint, presentFullTakeoffStatus, presentFullTakeoffRegions, isFullRegionalPass, fullRegionRectangle } from '../app/src/utils/aiPlanStatus.ts';
import type { FullTakeoffRun, FullTakeoffCheckpoint } from '../app/src/services/api.ts';

const plansCode = readFileSync(new URL('../app/src/pages/PlansPageContent.tsx', import.meta.url), 'utf8');
const modalCode = readFileSync(new URL('../app/src/components/AIPlanModal.tsx', import.meta.url), 'utf8');
function productionFunction(code: string, name: string, context: Record<string, unknown>) {
  const source = ts.createSourceFile('UI.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer: ts.Expression | ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) initializer = node.initializer;
    if (ts.isFunctionDeclaration(node) && node.name?.getText(source) === name) initializer = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(initializer, `${name} exists in the production component`);
  const compiled = ts.transpileModule(`(${initializer.getText(source).replace(/^export\s+/, '')})`, {
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
  assert.match(state.savedProgress, /10\/10 reading steps saved/);
  assert.match(state.notice, /unresolved items/);
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
    assert.equal(presentFullTakeoffStatus(run({ progress })).savedProgress, 'Reading progress is not available yet');
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
    fullSpendApproval: { confirmed: true, policyId: 'unit-profile', budgetsUsd: { gemini: 1 } },
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
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.calls)), [['workspace', 'project', 'file', { confirmed: true, policyId: 'unit-profile', budgetsUsd: { gemini: 1 } }]]);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.patch)), [['revision', { aiPlanJobId: 'durable-run', aiPlanStatus: 'queued', aiPlanMode: 'full_v2' }]]);
  assert.equal((fixture.context.paidActionInFlight as { current: boolean }).current, false);
});

test('Full V2 selection cannot dispatch when this workspace is not entitled', async () => {
  const fixture = startContext({ fullTakeoffV2Available: false });
  await productionFunction(plansCode, 'handleStartFreeReading', fixture.context)();
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.patch.length, 0);
});

test('Full V2 start requires the current explicit user spend approval', async () => {
  const fixture = startContext({ fullSpendApproval: null });
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
    Loader2: () => null, canWrite: false, runAction: null, jobError: null, runActionError: null, measurementPage: null,
    checkpoints: { '1:geometry': { checkpoint: { observations: [{ description: 'Scale evidence', source_excerpt: '<script>drawing text</script>' }], blockers: ['Wall height is absent.'] } } },
    checkpointErrors: {}, loadingCheckpoints: {}, handleLoadCheckpoint: noop, selectedRegions: {}, regionalCheckpoints: {}, presentFullTakeoffRegions, isFullRegionalPass,
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

const regionalRectangle = { row: 1, column: 1, rows: 2, columns: 2, x: 0, y: 47, width: 53, height: 53 };
function regionalCheckpoint(patch: Partial<FullTakeoffCheckpoint> = {}): FullTakeoffCheckpoint {
  return { id: 'durable-run', mode: 'full_v2', sheet: { id: 'sheet', physical_page_number: 1, status: 'blocked', status_reason: 'Review pending' },
    pass: { plan_sheet_id: 'sheet', pass_type: 'discipline', attempt: 1, status: 'blocked', provider: 'anthropic', model: 'configured-model',
      checkpoint: { observations: [{ description: 'Wall intersection', source_excerpt: '<script>source marker</script>' }], blockers: ['Hidden segment remains unresolved.'] },
      failure_classification: null, started_at: null, completed_at: null }, region: { key: 'r1c1g2', rectangle: regionalRectangle, status: 'blocked' }, ...patch };
}

test('checkpoint API preserves aggregate GET and encodes one optional regional key without invoking a generator', async () => {
  const calls: unknown[] = [], api = readFileSync(new URL('../app/src/services/api.ts', import.meta.url), 'utf8');
  const get = productionFunction(api, 'getFullTakeoffCheckpoint', { request: async (...args: unknown[]) => { calls.push(args); return {}; }, encodeURIComponent });
  await get('workspace', 'run/id', 1, 'conflict_detection');
  await get('workspace', 'run/id', 1, 'conflict_detection', 'r1c1g2');
  await get('workspace', 'run/id', 1, 'conflict_detection', 'r1&pass_type=geometry');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['/api/takeoff-runs/run%2Fid?page_number=1&pass_type=conflict_detection', { workspaceId: 'workspace' }],
    ['/api/takeoff-runs/run%2Fid?page_number=1&pass_type=conflict_detection&region_key=r1c1g2', { workspaceId: 'workspace' }],
    ['/api/takeoff-runs/run%2Fid?page_number=1&pass_type=conflict_detection&region_key=r1%26pass_type%3Dgeometry', { workspaceId: 'workspace' }],
  ]);
});

test('regional coverage keeps saved blockers/unknown statuses and reports unvisited regions as pending', () => {
  const result = presentFullTakeoffRegions({ source_coverage: { completed_regions: 2, total_regions: 4, regions: [
    { region_key: 'r1c1g2', region: regionalRectangle, status: 'blocked' },
    { region_key: 'r1c2g2', region: { ...regionalRectangle, column: 2 }, status: 'UNKNOWN_PROVIDER_STATE' },
    { region_key: 'r1c1g2', status: 'succeeded' }, { region_key: 'r3c3g2', status: 'succeeded' }, { region_key: 'unscoped', status: 'succeeded' },
  ] } });
  assert.equal(result.regions.length, 2); assert.equal(result.regions[0]!.status, 'blocked');
  assert.equal(result.regions[1]!.status, 'UNKNOWN_PROVIDER_STATE'); assert.match(result.progress, /2\/4.*remaining regions are pending/);
  assert.equal(isFullRegionalPass('discipline'), true); assert.equal(isFullRegionalPass('geometry'), false);
  assert.equal(fullRegionRectangle({ ...regionalRectangle, height: 0 }), null);
  assert.equal(presentFullTakeoffRegions({ source_coverage: { regions: [{ region: regionalRectangle }] } }).regions.length, 0);
});

function regionalReadFixture(overrides: Record<string, unknown> = {}) {
  const calls: unknown[] = [], aggregate: unknown[] = [], regional: Record<string, FullTakeoffCheckpoint> = {}, errors: Record<string, string> = {};
  const context: Record<string, unknown> = { workspaceId: 'workspace', jobId: 'durable-run', contextKey: 'same', reviewContext: { current: 'same' },
    checkpointRequests: { current: new Set<string>() }, setLoadingCheckpoints: noop,
    setCheckpointErrors: (update: (prior: Record<string, string>) => Record<string, string>) => Object.assign(errors, update(errors)),
    setCheckpoints: (value: unknown) => aggregate.push(value),
    setRegionalCheckpoints: (update: (prior: Record<string, FullTakeoffCheckpoint>) => Record<string, FullTakeoffCheckpoint>) => Object.assign(regional, update(regional)),
    getFullTakeoffCheckpoint: async (...args: unknown[]) => { calls.push(args); return regionalCheckpoint(); },
    readableError: (error: Error) => error.message, ...overrides };
  return { calls, aggregate, regional, errors, context };
}

test('modal reads a selected saved region independently of overall run state and leaves aggregate evidence intact', async () => {
  const fixture = regionalReadFixture();
  const read = productionFunction(modalCode, 'handleLoadCheckpoint', fixture.context);
  await read(1, 'discipline', 'r1c1g2');
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.calls)), [['workspace', 'durable-run', 1, 'discipline', 'r1c1g2']]);
  assert.equal(fixture.aggregate.length, 0); assert.equal(fixture.regional['1:discipline:region=r1c1g2']!.region!.status, 'blocked');
});

test('regional reads deduplicate in-flight selections and reject cross-page identity rather than falling back to aggregate', async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise(done => { resolve = done; });
  const fixture = regionalReadFixture(); fixture.context.getFullTakeoffCheckpoint = async (...args: unknown[]) => { fixture.calls.push(args); return pending; };
  const read = productionFunction(modalCode, 'handleLoadCheckpoint', fixture.context);
  const first = read(1, 'discipline', 'r1c1g2'), second = read(1, 'discipline', 'r1c1g2');
  assert.equal(fixture.calls.length, 1);
  resolve(regionalCheckpoint({ sheet: { id: 'sheet-other', physical_page_number: 2, status: 'blocked', status_reason: null } }));
  await Promise.all([first, second]);
  assert.equal(Object.keys(fixture.regional).length, 0); assert.equal(fixture.aggregate.length, 0);
  assert.match(fixture.errors['1:discipline:region=r1c1g2']!, /identity could not be verified/);
});

test('regional inspector renders saved excerpts/blockers and an unknown processing payload without inventing quantities', () => {
  const render = productionFunction(modalCode, 'FullRegionalEvidence', { React, presentFullTakeoffCheckpoint, fullRegionRectangle });
  const html = renderToStaticMarkup(render({ saved: regionalCheckpoint() }));
  assert.match(html, /Region r1c1g2/); assert.match(html, /Row 1, column 1/); assert.match(html, /Neighboring regions overlap/);
  assert.match(html, /Hidden segment remains unresolved/); assert.match(html, /&lt;script&gt;source marker/);
  assert.match(html, /no measured quantity or price is certified/); assert.doesNotMatch(html, /<script>|100%|total price/);
  const saved = regionalCheckpoint(); saved.pass.checkpoint = null; saved.region!.status = 'UNKNOWN_PROVIDER_STATE';
  const unknown = renderToStaticMarkup(render({ saved }));
  assert.match(unknown, /UNKNOWN_PROVIDER_STATE/); assert.match(unknown, /No regional checkpoint payload has been saved yet/);
});

test('Full modal exposes individual saved regions even when aggregate observations were removed by the response bound', () => {
  const FullRegionalEvidence = productionFunction(modalCode, 'FullRegionalEvidence', { React, presentFullTakeoffCheckpoint, fullRegionRectangle });
  const render = productionFunction(modalCode, 'renderFullRun', { React, presentFullTakeoffStatus, presentFullTakeoffCheckpoint, isAiPlanInFlight,
    Loader2: () => null, canWrite: false, runAction: null, jobError: null, runActionError: null, measurementPage: null,
    checkpoints: { '1:discipline': { checkpoint: { observations: [], blockers: ['Aggregate evidence exceeds the response bound. Inspect individual regions.'],
      source_coverage: { completed_regions: 1, total_regions: 4, regions: [{ region_key: 'r1c1g2', region: regionalRectangle, status: 'blocked' }] } } } },
    checkpointErrors: {}, loadingCheckpoints: {}, handleLoadCheckpoint: noop, selectedRegions: { '1:discipline': 'r1c1g2' },
    regionalCheckpoints: { '1:discipline:region=r1c1g2': regionalCheckpoint() }, presentFullTakeoffRegions, isFullRegionalPass, FullRegionalEvidence,
  });
  const saved = regionalCheckpoint();
  const html = renderToStaticMarkup(render(run({ status: 'failed', sheets: [{ ...saved.sheet, passes: [saved.pass] }] })));
  assert.match(html, /Inspect saved evidence by region/); assert.match(html, /Saved region on sheet 1 for discipline/);
  assert.match(html, /remaining regions are pending/); assert.match(html, /Selected regional evidence/); assert.match(html, /Wall intersection/);
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

test('configuration recovery sends current approval through resume without changing legacy cancellation',async()=>{
  const calls:unknown[]=[],approval={confirmed:true,policyId:'current',budgetsUsd:{gemini:1}};
  const context={canWrite:true,workspaceId:'workspace',jobId:'run',fullRun:run({status:'failed',error_code:'reading_configuration_unavailable',payment_kind:'complimentary'}),
    runActionInFlight:{current:false},runActionNeedsRefresh:{current:false},presentFullTakeoffStatus,
    reviewContext:{current:'same'},contextKey:'same',setRunAction:noop,setRunActionError:noop,setFullRun:noop,setReload:noop,
    cancelFullTakeoffRun:async()=>{throw new Error('No cancellation');},
    restartFullTakeoffRun:async(...args:unknown[])=>{calls.push(args);return{id:'run',status:'queued'};}};
  await productionFunction(modalCode,'handleRunAction',context)('restart',approval);
  assert.deepEqual(calls,[['workspace','run',approval]]);
});

test('restart API serializes fresh approval only when supplied',async()=>{
  const calls:any[]=[],api=readFileSync(new URL('../app/src/services/api.ts',import.meta.url),'utf8');
  const restart=productionFunction(api,'restartFullTakeoffRun',{request:async(...args:any[])=>calls.push(args),encodeURIComponent});
  const approval={confirmed:true,policyId:'current',budgetsUsd:{gemini:1}};
  await restart('workspace','run',approval);await restart('workspace','run');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1].body)),{spend_approval:approval});
  assert.equal('body' in calls[1][1],false,'normal resume retains its original request contract');
});
