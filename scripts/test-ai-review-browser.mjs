import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';

// Isolated synthetic review responses. No auth, customer PDF, AI or payment.
const playwright = await import(new URL('../.browser-tests/node_modules/playwright/index.mjs', import.meta.url).href);
const repo = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(path.join(repo, '.review-check-'));
let server;
try {
  await writeFile(path.join(root, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>');
  await writeFile(path.join(root, 'main.tsx'), `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AIPlanModal } from '../apps/web/app/src/components/AIPlanModal';
import { appendAcceptedAiQuantity } from '../apps/web/app/src/utils/aiFindingReview';
window.reviewHarness = { loads: 0, writes: 0, imports: 0, status: 'needs_review', failLoad: location.search.includes('fail'), lastEstimate: null };
function Fixture() {
  const [open, setOpen] = useState(true);
  const [project, setProject] = useState({ id: 'review-project', name: 'SYNTHETIC review test', quantities: [], estimateItems: [], revisions: [{ id: 'revision', isCurrent: true, fileName: 'fixture.pdf', revisionNumber: '01', aiPlanJobId: 'saved-job' }] });
  return <><button data-testid="reopen" onClick={() => setOpen(true)}>Reopen review</button><AIPlanModal project={project} workspaceId="fixture-workspace" isOpen={open} onClose={() => setOpen(false)} onAddQuantityItem={item => { window.reviewHarness.imports++; setProject(previous => { const next = appendAcceptedAiQuantity(previous, item); window.reviewHarness.lastEstimate = next.estimateItems[0]; return next; }); }} /></>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`);
  const stub = `
export class ApiError extends Error {}
export async function getAiPlanReading() {
  const h = window.reviewHarness; h.loads++;
  if (h.failLoad) { h.failLoad = false; throw new Error('Synthetic temporary load failure'); }
  return { id: 'saved-job', status: 'needs_review', plan_reading_findings: [{ id: 'finding', finding_type: 'material', label: 'Synthetic drywall', quantity: 500, unit: 'SF', page_number: 2, source_excerpt: '500 SF gypsum board', confidence: 0.9, geometry: { area: 'Living Room', pricing: [{ category: 'material', cost: 999999 }] }, status: h.status }] };
}
export async function setPlanReadingFindingStatus(workspaceId, findingId, status) {
  window.reviewHarness.writes++;
  await new Promise(resolve => setTimeout(resolve, 200));
  window.reviewHarness.status = status;
  return { id: findingId, status };
}
`;
  const vercel = JSON.parse(await readFile(path.join(repo, 'vercel.json'), 'utf8'));
  const csp = vercel.headers.flatMap(rule => rule.headers ?? []).find(header => header.key.toLowerCase() === 'content-security-policy').value;
  const config = {
    configFile: false, root, base: '/', plugins: [react(), {
      name: 'isolated-review-api',
      enforce: 'pre',
      resolveId(source, importer) {
        if (importer?.replaceAll('\\', '/').endsWith('/components/AIPlanModal.tsx') && source === '../services/api') return '\0review-fixture-api';
      },
      load(id) { if (id === '\0review-fixture-api') return stub; },
    }],
    build: { outDir: path.join(root, 'dist'), emptyOutDir: true },
    preview: { host: '127.0.0.1', port: 4181, strictPort: true, headers: { 'Content-Security-Policy': csp } },
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
      await page.goto('http://127.0.0.1:4181/?fail=1');
      await page.getByRole('button', { name: 'Retry loading saved reading' }).click();
      await page.getByRole('button', { name: 'Add Item', exact: true }).waitFor({ timeout: 5000 }).catch(async error => { console.log(await page.locator('body').innerText()); throw error; });
      await page.getByRole('button', { name: 'Add Item', exact: true }).evaluate(button => { button.click(); button.click(); });
      await page.waitForFunction(() => window.reviewHarness.imports === 1);
      assert.equal(await page.evaluate(() => window.reviewHarness.writes), 1);
      const line = await page.evaluate(() => window.reviewHarness.lastEstimate);
      assert.equal(line.quantity, 500);
      assert.equal(line.unit, 'SF');
      assert.equal(line.pricingStatus, 'missing_price');
      assert.equal(line.materialCost, 0);
      assert.equal(line.pricingSource, undefined);

      // A successful status write may outlive a closed review. On reopening,
      // accepted-but-unlinked evidence must still be importable exactly once.
      await page.goto('http://127.0.0.1:4181/');
      await page.getByRole('button', { name: 'Add Item', exact: true }).click();
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await page.waitForFunction(() => window.reviewHarness.status === 'accepted');
      assert.equal(await page.evaluate(() => window.reviewHarness.imports), 0);
      await page.getByTestId('reopen').click();
      await page.getByRole('button', { name: 'Add Item', exact: true }).click();
      await page.waitForFunction(() => window.reviewHarness.imports === 1);
      assert.equal(await page.evaluate(() => window.reviewHarness.writes), 1, 'Recover the saved acceptance without another status write.');
      assert.deepEqual(errors, []);
      console.log('PASS ' + browserName + ': saved-result retry, reentrant acceptance, evidence-only pricing, close/reopen recovery');
    } finally { await browser.close(); }
  }
} finally {
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  const cleanupRoot = path.resolve(root);
  if (!cleanupRoot.startsWith(path.resolve(repo) + path.sep) || !path.basename(cleanupRoot).startsWith('.review-check-')) throw new Error('Refusing cleanup outside the isolated review fixture.');
  await rm(cleanupRoot, { recursive: true, force: true });
}
