import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Execute each real handler body from the TSX source. State setters intentionally
// do not rerender: a second click before React commits must still be excluded.
// This is a handler regression test, not a substitute for the browser CI gate.
const code = readFileSync(new URL('../app/src/pages/PlansPageContent.tsx', import.meta.url), 'utf8');
const source = ts.createSourceFile('PlansPageContent.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['handlePay', 'handleFileUpload', 'handleStartFreeReading', 'handleStartAiReading', 'handleRecalculateQuote'] as const;
function handler(name: string, context: Record<string, unknown>): (...args: any[]) => Promise<void> {
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(initializer, `Production handler ${name} must exist`);
  const js = ts.transpileModule(`(${initializer.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return runInNewContext(js, context);
}
function harness() {
  let reject!: (reason: Error) => void;
  const pending = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; });
  const calls: string[] = [];
  const network = (name: string) => (..._args: unknown[]) => { calls.push(name); return pending; };
  const lock = { current: false };
  const noop = (..._args: unknown[]) => {};
  const context: Record<string, unknown> = {
    canWrite: true, workspaceId: 'workspace-1', project: { remoteId: 'project-1', revisions: [], projectType: 'Residential' },
    currentRevision: { id: 'revision-1', remoteFileId: 'file-1' },
    readingQuote: { id: 'quote-1', file_id: 'file-1' }, quoteRecoveryReady: true,
    isUploading: false, isStartingAi: false, isPaying: false, paidActionInFlight: lock,
    contextKey: 'same-context', contextRef: { current: 'same-context' }, selectedTrades: ['Framing'], fullTakeoffV2: false,
    setIsPaying: noop, setIsUploading: noop, setIsStartingAi: noop, setPlanNotice: noop,
    setNeedsAiConsent: noop, setReadingQuote: noop, setFindings: noop,
    readableApiError: () => 'Controlled test failure', ApiError: class extends Error {},
    beginDocumentUpload: network('upload'), payForReading: network('checkout'),
    createAiPlanReading: network('generation'), getSavedReadingQuote: network('saved-quote'),
    getReadingQuote: network('new-quote'), getAiPlanReading: network('saved-reading'),
    window: { location: { assign: noop } },
  };
  const event = { currentTarget: { value: 'plan.pdf' }, target: { files: [{ name: 'plan.pdf', type: 'application/pdf', size: 1024 }] } };
  return { context, calls, lock, event, reject };
}

for (const first of names) {
  for (const second of names) {
    test(`${first} excludes ${second} before a React rerender`, async () => {
      const h = harness();
      const firstAction = handler(first, h.context)(h.event);
      const secondAction = handler(second, h.context)(h.event);
      // Release promises even on an assertion failure so the test cannot leave
      // rejected asynchronous work behind.
      const observed = h.calls.length;
      h.reject(new Error('Expected test transport rejection'));
      await Promise.all([firstAction, secondAction]);
      assert.equal(observed, 1, 'Only one expensive action may reach its first network boundary');
      assert.equal(h.lock.current, false, 'The lock must be released after an explicit failure');
    });
  }
}

for (const name of names) {
  test(`${name} denies a non-writer without acquiring the action lock`, async () => {
    const h = harness(); h.context.canWrite = false;
    await handler(name, h.context)(h.event);
    assert.equal(h.calls.length, 0); assert.equal(h.lock.current, false);
  });
}
