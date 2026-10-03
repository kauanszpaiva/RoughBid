import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Real photo UI, App recovery and HTTP serializer; all network responses are
// local synthetic fixtures. This script cannot contact storage, Stripe or AI.
const playwright = await import(process.env.PLAYWRIGHT_MODULE_PATH || new URL('../.browser-tests/node_modules/playwright/index.mjs', import.meta.url).href);
const repo = fileURLToPath(new URL('../', import.meta.url)), root = await mkdtemp(path.join(repo, '.photo-purchase-check-'));
const project = { id: 'project-local', remoteId: 'project-1', name: 'SYNTHETIC photo project', projectType: 'Residential', status: 'Planning', clientName: '', address: '', updatedAt: '', overheadPercentage: 12, markupPercentage: 20, quantities: [], estimateItems: [], revisions: [] };
const asset = id => ({ id, workspaceId: 'workspace-1', projectId: 'project-1', revision: 'a'.repeat(64), sha256: 'a'.repeat(64), mimeType: 'image/jpeg', byteSize: 10, widthPixels: 640, heightPixels: 480, storageVerified: true });
const quote = (ids = ['photo-1', 'photo-2'], patch = {}) => ({ id: 'quote-1', mode: 'photo_batch', workspace_id: 'workspace-1', project_id: 'project-1', amount_cents: 1937, currency: 'usd', status: 'quoted', expires_at: '2099-01-01T00:00:00Z', contract_hash: 'b'.repeat(64), run_id: null, consent_confirmed: false, assets: ids.map(asset),
  summary: { assetIds: ids, assetCount: ids.length, stages: ['observation', 'reconciliation', 'risk_review'], providers: [{ provider: 'synthetic-provider', models: ['synthetic-model'] }], maximumCalls: ids.length + 2, pricingExpiresAt: '2099-01-01T00:00:00Z', executionPolicy: 'one-durable-photo-run-budget-wait-no-uncertain-replay' }, ...patch });
const run = (status = 'queued') => ({ id: 'run-1', status, request_key: 'saved-request-key', review_revision: 0, progress: { completed: status === 'needs_review' ? 4 : 0, total: 4 }, result: status === 'needs_review' ? { observations: [], approvedMeasurements: [], blockers: ['physical_scale_missing'], humanReviewRequired: true, releaseStatus: 'blocked', pricingStatus: 'missing_price', estimate: null, independentReview: 'completed', stageStatus: { observation: 'completed', reconciliation: 'completed', risk_review: 'completed' } } : null });
let server;
try {
  await writeFile(path.join(root, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>');
  await writeFile(path.join(root, 'styles.css'), '@import "../apps/web/app/src/index.css";\n@source "../apps/web/app/src";');
  await writeFile(path.join(root, 'main.tsx'), `import React from 'react'; import {createRoot} from 'react-dom/client'; import App from '../apps/web/app/src/App'; import {PhotoTakeoffPanel} from '../apps/web/app/src/components/PhotoTakeoffPanel'; import './styles.css'; createRoot(document.getElementById('root')).render(new URLSearchParams(location.search).has('app')?<App/>:<PhotoTakeoffPanel workspaceId="workspace-1" projectId="project-1" canWrite/>);`);
  const vercel = JSON.parse(await readFile(path.join(repo, 'vercel.json'), 'utf8'));
  const csp = vercel.headers.flatMap(rule => rule.headers ?? []).find(header => header.key.toLowerCase() === 'content-security-policy').value;
  const config = { configFile: false, root, base: '/', plugins: [react(), tailwindcss(), {
    name: 'isolated-photo-purchase', enforce: 'pre',
    resolveId(source) {
      if (source.endsWith('/supabaseClient') || source === './supabaseClient') return '\0fixture-auth';
      if (source.endsWith('/useSession')) return '\0fixture-session';
      if (source === './pages/PlansPage') return '\0fixture-plans';
    },
    load(id) {
      if (id === '\0fixture-auth') return 'export const supabase=null; export const isAuthConfigured=true;';
      if (id === '\0fixture-session') return 'const session={user:{id:"fixture-user",email:"fixture@example.invalid"}};export function useSession(){return {session,loading:false,error:null,retry(){}}}';
      if (id === '\0fixture-plans') return `import React from 'react';import {PhotoTakeoffPanel} from '${path.join(repo, 'apps/web/app/src/components/PhotoTakeoffPanel.tsx').replaceAll('\\', '/')}';export function PlansPage(props){return React.createElement(PhotoTakeoffPanel,{workspaceId:props.workspaceId,projectId:props.project.remoteId,canWrite:props.canWrite})}`;
    },
  }], build: { outDir: path.join(root, 'dist'), emptyOutDir: true }, preview: { host: '127.0.0.1', port: 4186, strictPort: true, headers: { 'Content-Security-Policy': csp } } };
  await build(config); server = await preview(config);
  for (const browserName of process.env.PURCHASE_TEST_BROWSERS?.split(',') ?? ['chromium', 'webkit']) {
    const browser = await playwright[browserName].launch({ headless: true, ...(browserName === 'chromium' && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    try {
      const context = await browser.newContext(browserName === 'webkit' ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1365, height: 900 } });
      await context.addInitScript(() => localStorage.clear());
      let page = await context.newPage(), state;
      const errors = [], external = [], unexpected = [];
      const observe = () => { page.setDefaultTimeout(12_000); page.on('pageerror', error => errors.push(error.message)); };
      observe();
      await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url()), method = req.method(), body = req.headers()['content-type']?.includes('json') ? req.postDataJSON() : undefined;
        if (url.hostname !== '127.0.0.1') { external.push(url.origin); return route.abort(); }
        if (url.pathname === '/checkout-fixture') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Synthetic checkout</title><p>No payment performed.</p>' });
        if (url.pathname.startsWith('/synthetic-upload/')) return route.fulfill({ status: 200, body: '' });
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const send = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
        state.calls.push({ path: url.pathname, query: url.search, method, body, workspace: req.headers()['x-workspace-id'] });
        if (url.pathname === '/api/auth/bootstrap') return send({ profile: { id: 'fixture-user', isPlatformAdmin: state.included, displayName: 'Fixture' } });
        if (url.pathname === '/api/pilot/access') return send({ enrolled: false, active: false });
        if (url.pathname === '/api/workspaces') return send([{ id: 'workspace-other', name: 'Other workspace', role: 'admin', createdAt: '2026-10-03' }, { id: 'workspace-1', name: 'Photo workspace', role: 'admin', createdAt: '2026-10-01' }]);
        if (url.pathname === '/api/projects' && method === 'GET') return send([{ id: 'project-1', name: project.name, status: 'active', app_state: project }]);
        if (url.pathname.endsWith('/ai-consent') && method === 'POST') { state.needsConsent = false; return send({ consented: true }); }
        if (url.pathname.endsWith('/photos/capability')) return send({ enabled: true, ownerAccess: state.included, includedAvailable: state.included, purchaseAvailable: true, workerReady: true });
        if (url.pathname.endsWith('/photos/uploads') && method === 'POST') {
          if (state.needsConsent) return send({ error: 'Workspace AI processing consent is required.' }, 403);
          const id = `photo-${++state.uploads}`; state.names[id] = body.name;
          return send({ asset: { id }, upload: { url: `http://127.0.0.1:4186/synthetic-upload/${id}`, method: 'PUT', headers: {} } });
        }
        if (/\/photos\/uploads\/photo-\d+\/complete$/.test(url.pathname)) {
          const id = url.pathname.split('/').at(-2);
          if (state.failUpload && state.names[id] === 'retry.jpg') { state.failUpload = false; return send({ error: 'Synthetic upload interruption' }, 503); }
          return send({ asset: asset(id) });
        }
        if (url.pathname.endsWith('/photos/quote') && method === 'GET') {
          if (url.searchParams.has('quote_id')) return send({ quote: state.quote?.id === url.searchParams.get('quote_id') ? state.quote : null });
          if (url.searchParams.has('asset_ids')) return send({ quote: state.quote?.summary.assetIds.slice().sort().join(',') === url.searchParams.get('asset_ids').split(',').sort().join(',') ? state.quote : null });
          return send({ quote: state.quote });
        }
        if (url.pathname.endsWith('/photos/quote') && method === 'POST') { state.quote = quote(body.assetIds); return send({ quote: state.quote }); }
        if (url.pathname.endsWith('/photos/checkout') && method === 'POST') {
          assert.deepEqual(body, { quoteId: state.quote.id, consent: { confirmed: true, contract_hash: state.quote.contract_hash } });
          state.quote.consent_confirmed = true; return send({ url: 'http://127.0.0.1:4186/checkout-fixture' });
        }
        if (url.pathname.endsWith('/photos/runs') && method === 'GET') return send({ runs: state.run ? [state.run] : [] });
        if (url.pathname.endsWith('/photos/runs') && method === 'POST') {
          if (body.quoteId) { assert.equal(state.quote.status, 'paid'); assert.equal(state.quote.consent_confirmed, true); assert.deepEqual(body, { quoteId: state.quote.id }); state.quote = { ...state.quote, status: 'processing', run_id: 'run-1' }; }
          else { assert.equal(state.included, true); assert.equal(body.consentConfirmed, true); assert.equal(body.assetIds.length, 2); assert.ok(body.requestKey); }
          state.run = run(); return send({ run: state.run, enqueued: true }, 202);
        }
        if (url.pathname.endsWith('/photos/runs/run-1') && method === 'GET') {
          const saved = state.run ?? run(), assets = state.quote?.assets ?? ['photo-1', 'photo-2'].map(asset), finished = saved.status === 'needs_review';
          return send({ run: saved, assets, references: [], stageCheckpoints: state.stages, steps: assets.map(value => ({ photo_asset_id: value.id, status: finished ? 'completed' : 'pending' })), coverage: { version: 'photo-evidence-v1', totalAssets: assets.length, processedAssetIds: finished ? assets.map(value => value.id) : [], pendingAssetIds: finished ? [] : assets.map(value => value.id), unassessedAssetIds: [], unusableAssetIds: [], additionalViewAssetIds: finished ? [assets[0].id] : [], unresolvedObservationIds: [], referenceRequiredObservationIds: [], processingComplete: finished, completeTakeoffVerified: false, estimateStatus: 'pending' } });
        }
        unexpected.push(`${method} ${url.pathname}`); return send({ error: 'Unexpected synthetic request' }, 500);
      });
      const assertClean = () => { assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(unexpected, []); };
      const navigate = async (suffix = '', patch = {}) => {
        await page.waitForLoadState('networkidle'); assertClean(); page.removeAllListeners('pageerror'); await page.close(); page = await context.newPage(); observe();
        state = { included: false, quote: null, run: null, uploads: 0, names: {}, calls: [], ...patch };
        await page.goto('http://127.0.0.1:4186/' + suffix); await page.getByRole('region', { name: 'Photo takeoff' }).waitFor(); await page.waitForLoadState('networkidle');
      };
      const panel = () => page.getByRole('region', { name: 'Photo reading confirmation' });
      const posts = ending => state.calls.filter(value => value.method === 'POST' && value.path.endsWith(ending));
      const mutations = () => state.calls.filter(value => value.method !== 'GET');
      const choose = async (names = ['first.jpg', 'second.jpg']) => page.getByLabel('Select construction photos').setInputFiles(names.map(name => ({ name, mimeType: 'image/jpeg', buffer: Buffer.from('SYNTHETIC, NOT A SOURCE PHOTO') })));
      const twice = async locator => { await page.waitForFunction(button => !button.disabled, await locator.elementHandle()); await locator.evaluate(button => { button.click(); button.click(); }); };
      const returned = '?app=1&reading_mode=photo_batch&payment=returned&workspace_id=workspace-1&project_id=project-1&photo_quote_id=quote-1';

      await navigate(); await choose(); await panel().getByText('$19.37', { exact: true }).waitFor();
      assert.equal(posts('/photos/uploads').length, 2); assert.equal(posts('/photos/quote').length, 1); assert.equal(posts('/photos/runs').length, 0);
      assert.equal(await panel().getByRole('button', { name: 'Pay securely with Stripe' }).isDisabled(), true);
      assert.equal(await panel().getByText('synthetic-model', { exact: false }).count(), 0);
      await panel().getByRole('checkbox').check(); await twice(panel().getByRole('button', { name: 'Pay securely with Stripe' })); await page.waitForURL('**/checkout-fixture');
      assert.equal(posts('/photos/checkout').length, 1); assert.equal(posts('/photos/runs').length, 0);

      await navigate('', { included: true }); await choose(); await panel().getByText('Included with your access').waitFor();
      assert.equal(posts('/photos/quote').length, 0); assert.equal(posts('/photos/checkout').length, 0); assert.equal(posts('/photos/runs').length, 0);
      await panel().getByRole('checkbox').check(); await twice(panel().getByRole('button', { name: 'Read my photos' }));
      await page.getByText('Photo reading: queued', { exact: true }).waitFor(); assert.equal(posts('/photos/runs').length, 1); assert.equal(posts('/photos/checkout').length, 0);

      await navigate(returned, { quote: quote() }); await panel().getByText('Waiting for payment confirmation…').waitFor();
      assert.equal(state.calls.find(value => value.path === '/api/projects').workspace, 'workspace-1'); assert.deepEqual(mutations(), []);
      state.quote = quote(undefined, { status: 'processing', run_id: 'run-1', consent_confirmed: true }); state.run = run('needs_review');
      await page.getByText('2/2 photos processed', { exact: true }).waitFor({ timeout: 10_000 }); await page.getByText('Estimate pending.', { exact: false }).waitFor();
      assert.deepEqual(mutations(), []); await page.reload(); await page.getByText('2/2 photos processed', { exact: true }).waitFor(); assert.deepEqual(mutations(), []);
      assert.equal(await page.getByRole('list', { name: 'Photo reading steps' }).getByText('Completed', { exact: true }).count(), 3);

      await navigate(returned, { quote: quote(undefined, { status: 'processing', run_id: 'run-1', consent_confirmed: true }),
        run: { ...run('waiting_budget'), not_before: '2099-01-01T00:00:00Z' },
        stages: [{ operation_key: 'observed', stage: 'observation', asset_ids: ['photo-1', 'photo-2'], status: 'completed', completed_at: '2026-10-03T00:00:00Z' }] });
      await page.getByText('Waiting for processing capacity', { exact: true }).waitFor();
      await page.getByText(/Estimated next window/).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Resume saved photo reading' }).count(), 0);
      assert.equal(await page.getByRole('list', { name: 'Photo reading steps' }).getByText('Completed', { exact: true }).count(), 1); assert.deepEqual(mutations(), []);

      await navigate(returned.replace('returned', 'canceled'), { quote: quote() }); await panel().getByText(/Checkout was canceled/).waitFor(); assert.deepEqual(mutations(), []);
      await navigate('', { quote: quote() }); await panel().getByRole('checkbox').check(); state.quote.contract_hash = 'c'.repeat(64);
      await panel().getByRole('button', { name: 'Pay securely with Stripe' }).click(); await panel().getByText('The photos or price changed. Review this purchase and confirm again.').waitFor();
      assert.equal(await panel().getByRole('checkbox').isChecked(), false); assert.deepEqual(mutations(), []);

      await navigate('', { failUpload: true }); await choose(['first.jpg', 'retry.jpg', 'third.jpg']);
      await page.getByRole('button', { name: 'Retry unsaved photos' }).waitFor(); await page.waitForLoadState('networkidle');
      assert.equal(posts('/photos/uploads').length, 3); assert.equal(posts('/photos/quote').length, 0);
      await page.getByRole('button', { name: 'Retry unsaved photos' }).click(); await panel().getByText('$19.37', { exact: true }).waitFor();
      assert.equal(posts('/photos/uploads').length, 4); assert.equal(posts('/photos/quote').length, 1); assert.equal(posts('/photos/quote')[0].body.assetIds.length, 3); assert.equal(posts('/photos/runs').length, 0);

      await navigate('', { needsConsent: true }); await choose(); await page.getByRole('button', { name: 'Approve AI processing for this workspace' }).waitFor();
      assert.equal(posts('/photos/quote').length, 0); await page.getByRole('button', { name: 'Approve AI processing for this workspace' }).click();
      await panel().getByText('$19.37', { exact: true }).waitFor(); assert.equal(posts('/ai-consent').length, 1); assert.equal(posts('/photos/runs').length, 0);

      await navigate(returned, { included: true, quote: quote(undefined, { status: 'paid', consent_confirmed: true }) });
      await twice(panel().getByRole('button', { name: 'Resume purchased photo reading' })); await page.getByText('Photo reading: queued', { exact: true }).waitFor();
      assert.deepEqual(posts('/photos/runs').map(value => value.body), [{ quoteId: 'quote-1' }], 'Paid recovery never falls back to included execution');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assertClean();
      console.log(`PASS ${browserName}: automatic private uploads, retry only failed files, one photo purchase, included access, immutable consent, passive App return, recovered results, paid fallback, zero external traffic`);
    } finally { await browser.close(); }
  }
} finally {
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  const cleanup = path.resolve(root);
  if (!cleanup.startsWith(path.resolve(repo) + path.sep) || !path.basename(cleanup).startsWith('.photo-purchase-check-')) throw new Error('Unsafe fixture cleanup');
  await rm(cleanup, { recursive: true, force: true });
}
