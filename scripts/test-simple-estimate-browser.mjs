import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(process.env.ROUGH_BID_PLAYWRIGHT_MODULE ?? new URL('../.browser-tests/node_modules/playwright/index.mjs', import.meta.url).href);
const fixtureServer = await createServer({ configFile: fileURLToPath(new URL('./offline-browser-fixture.vite.ts', import.meta.url)), clearScreen: false });
await fixtureServer.listen();
const browser = await chromium.launch({ headless: true, ...(process.env.ROUGH_BID_CHROMIUM_EXECUTABLE ? { executablePath: process.env.ROUGH_BID_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const root = 'http://127.0.0.1:4187';
const photo = { name: 'bathroom.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64') };
const plan = { name: 'bathroom.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nSynthetic test source, no real geometry\n%%EOF') };
let passed = 0;
try {
  for (const [label, files, failPhoto, full, offline] of [['plans', [plan], false], ['photos', [photo], false], ['mixed', [plan, photo], false], ['photo retry', [photo], true], ['full-plan intake', [plan], false, true], ['offline worker recovery', [plan], false, true, true]]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === root || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
    });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${root}/offline-browser-fixture.html?view=intake${offline ? '&reading=offline' : full ? '&reading=full' : ''}`);
    await page.getByRole('dialog', { name: 'Start an estimate' }).waitFor();
    await page.evaluate(() => { window.__offlineFixture.uploadDelayMs = 600; });
    if (failPhoto) await page.evaluate(() => { window.__offlineFixture.failNextPhotoUpload = true; });
    await page.getByLabel('Add estimate photos and plans').setInputFiles(files);
    await page.getByLabel('Tile', { exact: true }).check();
    await page.getByRole('button', { name: 'Upload and continue' }).click();
    await page.getByRole('heading', { name: 'Your estimate', exact: true }).waitFor();
    const progressPanel = page.getByRole('region', { name: 'Estimate progress' });
    await progressPanel.getByText('Uploading your files…', { exact: true }).waitFor();
    await page.waitForFunction(() => {
      const requests = window.__offlineFixture.requests;
      return requests.some(request => request.path.endsWith('/documents/offline-pdf/complete')) || requests.some(request => /photos\/uploads\/[^/]+\/complete$/.test(request.path)) || document.body.textContent.includes('Synthetic upload interrupted');
    });
    if (!failPhoto && !offline) await progressPanel.getByText('Files saved — reading has not started', { exact: true }).waitFor();
    await page.getByRole('button', { name: '3. Generate estimate', exact: true }).click();
    assert.equal(await page.getByRole('checkbox', { name: /I agree to AI processing/ }).evaluate(input => input === document.activeElement), true);
    assert.equal(await page.evaluate(() => window.__offlineFixture.requests.filter(request => request.path.endsWith('/ai-plan-readings') && request.method === 'POST').length), 0);
    if (offline) {
      await progressPanel.getByText('Plan reading is temporarily offline', { exact: true }).waitFor();
      await page.getByRole('checkbox', { name: /I agree to AI processing/ }).check();
      await page.getByRole('button', { name: '3. Generate estimate', exact: true }).click();
      await page.getByText('Plan reading is temporarily offline. Your files are saved. Check processing availability again after the service restarts.', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__offlineFixture.requests.filter(request => request.path.endsWith('/ai-plan-readings') && request.method === 'POST').length), 0);
      await page.evaluate(() => { window.__offlineFixture.fullWorkerOffline = false; });
      await progressPanel.getByRole('button', { name: 'Check processing availability' }).click();
      await progressPanel.getByText('Files saved — reading has not started', { exact: true }).waitFor();
    }
    await page.getByRole('checkbox', { name: /I agree to AI processing/ }).check();
    const generate = page.getByRole('button', { name: '3. Generate estimate', exact: true });
    await generate.click();
    await page.waitForFunction(({ hasPlan, hasPhoto }) => {
      const requests = window.__offlineFixture.requests;
      return (!hasPlan || requests.some(request => request.path.endsWith('/ai-plan-readings') && request.method === 'POST')) && (!hasPhoto || requests.some(request => request.path.endsWith('/photos/runs') && request.method === 'POST'));
    }, { hasPlan: files.includes(plan), hasPhoto: files.includes(photo) });
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
    if (full || files.includes(photo)) await progressPanel.getByLabel('Estimate is working').waitFor();
    const requests = await page.evaluate(() => window.__offlineFixture.requests);
    const create = requests.find(request => request.path === '/api/projects' && request.method === 'POST');
    assert.equal(create.body.intakeMode, 'quick');
    assert.equal(create.body.clientName, '');
    assert.equal(create.body.jurisdictionState, undefined);
    const planCalls = requests.filter(request => request.path.endsWith('/ai-plan-readings') && request.method === 'POST');
    if (files.includes(plan)) { assert.equal(planCalls.length, 1); if (full) { assert.equal(planCalls[0].body.mode, 'full_v2'); assert.deepEqual(planCalls[0].body.spend_approval, { confirmed: true, policyId: 'offline-policy', budgetsUsd: { gemini: 0.25 } }); } else { assert.equal(planCalls[0].body.scope, 'Tile'); assert.deepEqual(planCalls[0].body.trades, ['Finishes']); } }
    else assert.equal(planCalls.length, 0);
    const photoCalls = requests.filter(request => request.path.endsWith('/photos/runs') && request.method === 'POST');
    assert.equal(photoCalls.length, files.includes(photo) ? 1 : 0);
    assert.equal(await page.getByText('Pricing pending', { exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    // A repeated click reuses the acknowledged plan/photo run instead of a
    // second inference request, even when the source stays in the UI.
    await generate.click();
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
    const after = await page.evaluate(() => window.__offlineFixture.requests);
    assert.equal(after.filter(request => request.path.endsWith('/ai-plan-readings') && request.method === 'POST').length, planCalls.length);
    assert.equal(after.filter(request => request.path.endsWith('/photos/runs') && request.method === 'POST').length, photoCalls.length);
    assert.deepEqual(errors, []);
    console.log(`PASS ${label}: real product components, one mixed intake, scoped plan request, no duplicate runs, pending prices and mobile layout`); passed++;
    await page.goto(`${root}/offline-browser-fixture.html?view=viewer`);
    assert.equal(await page.getByRole('button', { name: '3. Generate estimate', exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('Add photos and PDF plans').isDisabled(), true);
    console.log(`PASS ${label}: read-only workspace cannot upload or generate`); passed++;
    await context.close();
  }
  console.log(`${passed}/${passed} browser scenarios passed; APIs/storage are local mocks, no paid calls or production data.`);
} finally { await browser.close(); await fixtureServer.close(); }
