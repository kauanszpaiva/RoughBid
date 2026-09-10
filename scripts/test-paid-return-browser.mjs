import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';

// Actual Plans UI with isolated synthetic API responses. No auth, PDF, AI or payment calls.
const playwright = await import(new URL('../.browser-tests/node_modules/playwright/index.mjs', import.meta.url).href);
const repo = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(path.join(repo, '.paid-return-check-'));
let server;
try {
  await writeFile(path.join(root, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>');
  await writeFile(path.join(root, 'main.tsx'), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PlansPage } from '../apps/web/app/src/pages/PlansPageContent';
const params = new URLSearchParams(location.search);
window.paidReturnHarness = { reads: [], newQuotes: [], jobs: [], payments: 0, patches: 0, jobReads: 0, status: params.get('status') || 'paid', failLoad: params.has('fail'), aiAvailable: !params.has('offline') };
const project = { id: 'local-project', remoteId: 'project-1', name: 'SYNTHETIC paid-return test', projectType: 'Changed project type', revisions: [{ id: 'revision', remoteFileId: 'file-1', isCurrent: true, fileName: 'fixture.pdf', revisionNumber: '01', processingStatus: 'ready', ...(params.has('poll') ? { aiPlanJobId: 'saved-job', aiPlanStatus: 'processing' } : {}) }] };
createRoot(document.getElementById('root')).render(<PlansPage project={project} workspaceId="workspace-1" canWrite onPatchRevision={() => window.paidReturnHarness.patches++} onAppendRevision={() => {}} onUpdateProject={() => {}} onContinue={() => {}} onOpenAIAssistant={() => {}} />);
`);
  const stub = `
export class ApiError extends Error {}
export async function getCapabilities() { return { aiReadingAvailable: window.paidReturnHarness.aiAvailable, billing: true }; }
export async function getAiPlanEntitlement() { return { freeReadingAvailable: false, pilotActive: false }; }
const quote = () => ({ id: 'paid-quote', project_id: 'project-1', file_id: 'file-1', amount_cents: 500, currency: 'usd', page_count: 10, trades: ['Framing'], scope: 'Original paid scope', status: window.paidReturnHarness.status, attempts: 0, max_attempts: 2, job_id: ['complete', 'processing', 'revoked'].includes(window.paidReturnHarness.status) ? 'saved-job' : null, expires_at: '2099-01-01', membership: 'standard' });
const job = () => ({ id: 'saved-job', status: 'needs_review', plan_reading_findings: [], output_summary: {} });
export async function getSavedReadingQuote(workspace, project, file, id) {
  const h = window.paidReturnHarness; h.reads.push({ workspace, project, file, id });
  await new Promise(resolve => setTimeout(resolve, 100));
  if (h.failLoad) { h.failLoad = false; throw new Error('Synthetic payment state load failure'); }
  return h.status === 'none' ? null : quote();
}
export async function getReadingQuote(...args) { window.paidReturnHarness.newQuotes.push(args); return quote(); }
export async function createAiPlanReading(workspace, project, input) { window.paidReturnHarness.jobs.push({ workspace, project, input }); return job(); }
export async function getAiPlanReading() { window.paidReturnHarness.jobReads++; await new Promise(resolve => setTimeout(resolve, 250)); return job(); }
export async function payForReading() { window.paidReturnHarness.payments++; throw new Error('Unexpected payment'); }
export async function createDocumentPreviewObjectUrl() { return URL.createObjectURL(new Blob(['synthetic fixture'])); }
export async function beginDocumentUpload() { throw new Error('Unexpected upload'); }
export async function completeDocumentUpload() { throw new Error('Unexpected upload'); }
export async function createDocumentDownloadUrl() { throw new Error('Unexpected download'); }
export async function grantWorkspaceAiConsent() { throw new Error('Unexpected consent mutation'); }
`;
  const vercel = JSON.parse(await readFile(path.join(repo, 'vercel.json'), 'utf8'));
  const csp = vercel.headers.flatMap(rule => rule.headers ?? []).find(header => header.key.toLowerCase() === 'content-security-policy').value;
  const config = {
    configFile: false, root, base: '/', plugins: [react(), {
      name: 'isolated-paid-return-api', enforce: 'pre',
      resolveId(source, importer) {
        if (!importer?.replaceAll('\\', '/').endsWith('/pages/PlansPageContent.tsx')) return;
        if (source === '../services/api') return '\0paid-return-fixture-api';
        if (source === '../components/BlueprintViewer') return '\0paid-return-fixture-viewer';
      },
      load(id) {
        if (id === '\0paid-return-fixture-api') return stub;
        if (id === '\0paid-return-fixture-viewer') return 'export function BlueprintViewer() { return null; }';
      },
    }],
    build: { outDir: path.join(root, 'dist'), emptyOutDir: true },
    preview: { host: '127.0.0.1', port: 4182, strictPort: true, headers: { 'Content-Security-Policy': csp } },
  };
  await build(config);
  server = await preview(config);
  for (const browserName of ['chromium', 'webkit']) {
    const browser = await playwright[browserName].launch({ headless: true,
      ...(browserName === 'chromium' && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    });
    try {
      const page = await browser.newPage({ viewport: browserName === 'webkit' ? { width: 390, height: 844 } : { width: 1365, height: 900 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      const assertPassive = async () => {
        const h = await page.evaluate(() => window.paidReturnHarness);
        assert.deepEqual(h.newQuotes, []);
        assert.deepEqual(h.jobs, []);
        assert.equal(h.payments, 0);
        assert.equal(h.patches, 0);
        assert.equal(h.jobReads, 0);
      };

      await page.goto('http://127.0.0.1:4182/?payment=returned');
      await page.getByText('Payment confirmed', { exact: true }).waitFor();
      await assertPassive();
      assert.equal(await page.getByRole('checkbox', { name: 'Framing', exact: true }).isChecked(), true);
      assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 1);
      assert.equal(await page.getByText('Saved scope: Original paid scope').isVisible(), true);
      await page.getByRole('button', { name: 'Start paid analysis', exact: true }).evaluate(button => { button.click(); button.click(); });
      await page.waitForFunction(() => window.paidReturnHarness.jobs.length === 1);
      const started = await page.evaluate(() => window.paidReturnHarness);
      assert.deepEqual(started.jobs, [{ workspace: 'workspace-1', project: 'project-1', input: { file_id: 'file-1', quote_id: 'paid-quote', mode: 'quick', scope: 'Original paid scope', trades: ['Framing'] } }]);
      assert.equal(started.reads.at(-1).id, 'paid-quote');
      assert.deepEqual(started.newQuotes, []);

      // An upstream payment becomes visible on an explicit read-only refresh.
      await page.goto('http://127.0.0.1:4182/?status=quoted&payment=returned');
      await page.getByText('Awaiting payment', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Start paid analysis', exact: true }).count(), 0);
      await page.evaluate(() => { window.paidReturnHarness.status = 'paid'; });
      await page.getByRole('button', { name: 'Refresh payment status', exact: true }).click();
      await page.getByText('Payment confirmed', { exact: true }).waitFor();
      await assertPassive();
      assert.equal(await page.evaluate(() => window.paidReturnHarness.reads.at(-1).id), 'paid-quote');

      // Repricing also rechecks paid status and must not replace a newly paid quote.
      await page.goto('http://127.0.0.1:4182/?status=quoted');
      await page.getByText('Awaiting payment', { exact: true }).waitFor();
      await page.evaluate(() => { window.paidReturnHarness.status = 'paid'; });
      await page.getByRole('button', { name: 'Recalculate project price', exact: true }).click();
      await page.getByText('Payment confirmed', { exact: true }).waitFor();
      await assertPassive();

      await page.goto('http://127.0.0.1:4182/?status=complete&offline=1');
      await page.getByText('Reading ready to review', { exact: true }).waitFor();
      await assertPassive();
      await page.getByRole('button', { name: 'Open saved reading', exact: true }).click();
      await page.waitForFunction(() => window.paidReturnHarness.jobReads === 1);
      assert.equal(await page.evaluate(() => window.paidReturnHarness.jobs.length), 0);

      // A completed job never upgrades a refunded/revoked payment back to paid.
      await page.goto('http://127.0.0.1:4182/?status=revoked&poll=1');
      await page.getByText('Payment access revoked', { exact: true }).waitFor();
      await page.waitForFunction(() => window.paidReturnHarness.patches === 1);
      assert.equal(await page.getByText('Payment access revoked', { exact: true }).isVisible(), true);
      assert.equal(await page.getByRole('button', { name: 'Open saved reading', exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => window.paidReturnHarness.jobs.length), 0);

      await page.goto('http://127.0.0.1:4182/?fail=1');
      const retry = page.getByRole('button', { name: 'Payment status could not be loaded. Retry.', exact: true });
      await retry.waitFor();
      assert.equal(await page.getByRole('button', { name: 'Calculate project price', exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole('checkbox', { name: 'Framing', exact: true }).isDisabled(), true);
      await assertPassive();
      await retry.click();
      await page.getByText('Payment confirmed', { exact: true }).waitFor();
      await assertPassive();
      assert.deepEqual(errors, []);
      console.log('PASS ' + browserName + ': passive paid return, original scope, explicit single AI start, payment refresh, safe repricing, saved reading offline, revocation retained, recovery failure/retry');
    } finally { await browser.close(); }
  }
} finally {
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  const cleanupRoot = path.resolve(root);
  if (!cleanupRoot.startsWith(path.resolve(repo) + path.sep) || !path.basename(cleanupRoot).startsWith('.paid-return-check-')) throw new Error('Refusing cleanup outside the isolated paid-return fixture.');
  await rm(cleanupRoot, { recursive: true, force: true });
}
