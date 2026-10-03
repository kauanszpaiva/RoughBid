import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Real App/Plans/purchase/HTTP serialization; every response below is synthetic.
// All non-local traffic is blocked. No Stripe SDK, payment, upload or AI provider.
const playwright = await import(process.env.PLAYWRIGHT_MODULE_PATH || new URL('../.browser-tests/node_modules/playwright/index.mjs', import.meta.url).href);
const repo = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(path.join(repo, '.full-purchase-check-'));
const revision = (id, file, current) => ({ id, remoteFileId: file, isCurrent: current, revisionNumber: current ? '02' : '01', fileName: `${file}.pdf`, processingStatus: 'ready', fileSize: '1 KB', pages: 2, uploadDate: 'Synthetic fixture', uploadedBy: 'Fixture', notes: '', annotations: [] });
const project = { id: 'local-project', remoteId: 'project-1', name: 'SYNTHETIC purchase fixture', projectType: 'Residential', status: 'Planning', clientName: 'Fixture', address: '', updatedAt: 'Fixture', overheadPercentage: 12, markupPercentage: 20, quantities: [], estimateItems: [], revisions: [revision('original-revision', 'file-1', false), revision('new-revision', 'file-2', true)] };
const quote = (patch = {}) => ({ id: 'quote-1', project_id: 'project-1', file_id: 'file-1', amount_cents: 3278, currency: 'usd', page_count: 2, trades: [], scope: 'All physical pages of the selected PDF', status: 'quoted', attempts: 0, max_attempts: 1, job_id: null, expires_at: '2099-01-01T00:00:00Z', membership: 'standard', mode: 'full_v2', full_run_id: null, full_contract_hash: 'a'.repeat(64), full_consent_confirmed: false,
  full_summary: { physicalPageCount: 2, regionGrid: 2, stages: ['classification', 'discipline', 'completeness'], providers: [{ provider: 'synthetic-provider', models: ['synthetic-model'], maximumCalls: 32 }], maximumCalls: 32, executionPolicy: 'one-durable-run-budget-wait-no-uncertain-replay', pricingVersion: 'synthetic-price-v1' }, ...patch });
const order = (files = ['file-1', 'file-2'], patch = {}) => ({ id: 'order-1', amount_cents: 3278 * files.length, currency: 'usd', status: 'quoted', expires_at: '2099-01-01T00:00:00Z', contract_hash: 'd'.repeat(64), items: files.map((file_id, index) => ({ ...quote({ file_id }), quote_id: `quote-${index + 1}` })), ...patch });
const run = (status = 'queued') => ({ id: 'run-1', mode: 'full_v2', status, progress: { completed: status === 'queued' ? 0 : 20, total: 20 }, sheets: [], output_summary: status === 'needs_review' ? { takeoff_v2: { releaseStatus: 'blocked' } } : null });
let server;
try {
  await writeFile(path.join(root, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>');
  await writeFile(path.join(root, 'styles.css'), '@import "../apps/web/app/src/index.css";\n@source "../apps/web/app/src";');
  await writeFile(path.join(root, 'main.tsx'), `
import React, {useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import App from '../apps/web/app/src/App';
import {PlansPage} from '../apps/web/app/src/pages/PlansPageContent';
import {AIPlanModal} from '../apps/web/app/src/components/AIPlanModal';
import {FullPurchasePanel} from '../apps/web/app/src/components/FullPurchasePanel';
import './styles.css';
function Fixture() {
  const [project,setProject]=useState(${JSON.stringify({ ...project, revisions: project.revisions.map(r => ({ ...r, isCurrent: r.remoteFileId === 'file-1' })) })});
  const [open,setOpen]=useState(false);
  const legacyLock=useRef(false), current=project.revisions.find(r=>r.isCurrent);
  return <><button onClick={()=>setProject(p=>({...p,revisions:p.revisions.map(r=>({...r,isCurrent:r.remoteFileId==='file-2'}))}))}>Select newer revision</button>
    {!new URLSearchParams(location.search).has('reading_mode')&&!new URLSearchParams(location.search).has('batch')&&<FullPurchasePanel key={current.remoteFileId} workspaceId="workspace-1" projectId="project-1" fileId={current.remoteFileId} fileName={current.fileName} revisionName={current.revisionNumber} canWrite available billingAvailable complimentaryAvailable externallyBusy={false} actionLock={legacyLock} onBusyChange={()=>{}} onConsentRequired={()=>{}} beforeCheckout={async()=>{}} onRun={(run,open)=>{setProject(p=>({...p,revisions:p.revisions.map(r=>r.id===current.id?{...r,aiPlanMode:'full_v2',aiPlanJobId:run.id,aiPlanStatus:run.status}:r)}));if(open)setOpen(true)}}/>}
    <PlansPage project={project} workspaceId="workspace-1" canWrite onBeforeFullCheckout={async()=>{}} onBeforeOrderCheckout={async()=>{}} onPatchRevision={(id,patch)=>setProject(p=>({...p,revisions:p.revisions.map(r=>r.id===id?{...r,...patch}:r)}))} onAppendRevision={revision=>setProject(p=>({...p,revisions:[...p.revisions.map(r=>({...r,isCurrent:false})),revision]}))} onUpdateProject={setProject} onContinue={()=>{}} onOpenAIAssistant={()=>setOpen(true)}/>
    <AIPlanModal project={project} workspaceId="workspace-1" canWrite isOpen={open} onClose={()=>setOpen(false)} onAddQuantityItem={()=>{throw Error('Unexpected quantity')}}/>
  </>;
}
createRoot(document.getElementById('root')).render(new URLSearchParams(location.search).has('app')?<App/>:<Fixture/>);
`);
  const vercel = JSON.parse(await readFile(path.join(repo, 'vercel.json'), 'utf8'));
  const csp = vercel.headers.flatMap(rule => rule.headers ?? []).find(header => header.key.toLowerCase() === 'content-security-policy').value;
  const config = { configFile: false, root, base: '/', plugins: [react(), tailwindcss(), {
    name: 'isolated-full-purchase', enforce: 'pre',
    resolveId(source) {
      if (source.endsWith('/supabaseClient') || source === './supabaseClient') return '\0fixture-auth';
      if (source.endsWith('/useSession')) return '\0fixture-session';
      for (const name of ['BlueprintViewer', 'PhotoTakeoffPanel', 'ConstructionBudgetPanel', 'PageReviewPanel']) {
        if (source.endsWith('/' + name)) return '\0fixture-empty-' + name;
      }
    },
    load(id) {
      if (id === '\0fixture-auth') return 'export const supabase=null; export const isAuthConfigured=true;';
      if (id === '\0fixture-session') return 'const session={user:{id:"fixture-user",email:"fixture@example.invalid"}}; export function useSession(){return {session,loading:false,error:null,retry(){}}}';
      if (id.startsWith('\0fixture-empty-')) return `export function ${id.slice('\0fixture-empty-'.length)}(){return null}`;
    },
  }], build: { outDir: path.join(root, 'dist'), emptyOutDir: true }, preview: { host: '127.0.0.1', port: 4185, strictPort: true, headers: { 'Content-Security-Policy': csp } } };
  await build(config); server = await preview(config);
  for (const browserName of process.env.PURCHASE_TEST_BROWSERS?.split(',') ?? ['chromium', 'webkit']) {
    const browser = await playwright[browserName].launch({ headless: true, ...(browserName === 'chromium' && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    try {
      const context = await browser.newContext(browserName === 'webkit' ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1365, height: 900 } });
      await context.addInitScript(draft => {
        localStorage.clear();
        if (new URLSearchParams(location.search).has('draft')) {
          localStorage.setItem('roughbid_selected_workspace_v1:fixture-user', 'workspace-1');
          localStorage.setItem('roughbid_pending_project_v2:fixture-user:workspace-1:local-project', JSON.stringify([draft]));
        }
      }, { ...project, revisions: project.revisions.map(value => ({ ...value, isCurrent: value.remoteFileId === 'file-1' })) });
      let page = await context.newPage();
      page.setDefaultTimeout(12_000);
      const errors = [], external = [], unexpected = [];
      page.on('pageerror', error => errors.push(error.message));
      let state;
      await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url()), method = req.method(), body = req.headers()['content-type']?.includes('json') ? req.postDataJSON() : undefined;
        if (url.hostname !== '127.0.0.1') { external.push(url.origin); return route.abort(); }
        if (url.pathname === '/checkout-fixture') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Synthetic checkout destination</title><p>No payment is performed.</p>' });
        if (url.pathname.startsWith('/synthetic-upload/')) return route.fulfill({ status: 200, body: '' });
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const send = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
        state.calls.push({ path: url.pathname, method, body, query: url.search, workspace: req.headers()['x-workspace-id'] });
        if (url.pathname === '/api/auth/bootstrap') return send({ profile: { id: 'fixture-user', isPlatformAdmin: state.owner, displayName: 'Fixture' } });
        if (url.pathname === '/api/pilot/access') return send({ enrolled: false, active: false });
        if (url.pathname === '/api/workspaces') return send([{ id: 'workspace-other', name: 'Different newer workspace', role: 'admin', createdAt: '2026-10-03' }, { id: 'workspace-1', name: 'Purchase workspace', role: 'admin', createdAt: '2026-10-01' }]);
        if (url.pathname === '/api/projects' && method === 'GET') return send([{ id: 'project-1', name: project.name, status: 'active', app_state: state.savedProject ?? (state.pendingRevision ? { ...project, revisions: project.revisions.filter(value => value.remoteFileId !== 'file-1') } : project) }]);
        if (url.pathname === '/api/projects/project-1' && method === 'PATCH') {
          if (state.failSave) return send({ error: 'Synthetic project save failed' }, 503);
          state.savedProject = body.appState;
          state.revisionSaved = body.appState.revisions.some(value => value.remoteFileId === 'file-1');
          return send({ id: 'project-1', name: project.name, status: 'active', app_state: body.appState });
        }
        if (url.pathname === '/api/capabilities') return send({ aiReadingAvailable: false, billing: false, fullTakeoffBilling: true });
        if (url.pathname.endsWith('/ai-plan-entitlement')) return send({ freeReadingAvailable: state.owner, fullTakeoffV2Available: false, fullTakeoffPurchaseAvailable: !state.offline });
        if (url.pathname.endsWith('/pricing-context')) return send({ error: 'No synthetic pricing context' }, 404);
        if (url.pathname.endsWith('/download-url')) return send({ error: 'Synthetic preview intentionally omitted' }, 404);
        if (url.pathname.endsWith('/documents/upload-url')) {
          const id = `upload-${(state.uploadNumber = (state.uploadNumber ?? 0) + 1)}`;
          state.uploads ??= {}; state.uploads[id] = body.name;
          return send({ file: { id }, upload: { url: `http://127.0.0.1:4185/synthetic-upload/${id}`, method: 'PUT', headers: {} } });
        }
        if (/\/documents\/upload-\d+\/complete$/.test(url.pathname)) {
          const id = url.pathname.split('/')[3];
          if (state.uploads[id] === 'retry.pdf' && !state.failedUploadOnce) { state.failedUploadOnce = true; return send({ error: 'Synthetic upload confirmation failed' }, 503); }
          return send({ id, page_count: 1, processing_status: 'ready' });
        }
        if (url.pathname.endsWith('/reading-order') && method === 'GET') {
          if (!state.order) return send(null);
          if (url.searchParams.has('order_id')) return send(url.searchParams.get('order_id') === state.order.id ? state.order : null);
          if (url.searchParams.has('contains_file_id')) return send(state.order.status !== 'quoted' && state.order.items.some(item => item.file_id === url.searchParams.get('contains_file_id')) ? state.order : null);
          return send((url.searchParams.get('file_ids') ?? '').split(',').sort().join(',') === state.order.items.map(item => item.file_id).sort().join(',') ? state.order : null);
        }
        if (url.pathname.endsWith('/reading-order') && method === 'POST') {
          if (state.needConsent) return send({ error: 'Workspace AI processing consent required' }, 403);
          assert.equal(body.file_ids.length > 0 && body.file_ids.length <= 20, true);
          state.order = order(body.file_ids); return send(state.order);
        }
        if (url.pathname.endsWith('/reading-order-checkout') && method === 'POST') {
          assert.deepEqual(body, { order_id: state.order.id, consent: { confirmed: true, contract_hash: state.order.contract_hash } });
          if (state.pendingRevision) assert.equal(state.revisionSaved, true);
          return send({ url: 'http://127.0.0.1:4185/checkout-fixture' });
        }
        if (url.pathname.endsWith('/reading-quote') && method === 'GET') {
          if (url.searchParams.get('mode') !== 'full_v2') return send(null);
          if (state.failRead && url.searchParams.has('quote_id')) { state.failRead = false; return send({ error: 'Synthetic purchase read unavailable' }, 503); }
          if (url.searchParams.get('file_id') !== 'file-1') return send(null);
          if (!state.quote && url.searchParams.has('quote_id')) return send({ error: 'Saved purchase not found' }, 404);
          return send(state.quote);
        }
        if (url.pathname.endsWith('/reading-quote') && method === 'POST') {
          assert.deepEqual(body, { mode: 'full_v2', file_id: 'file-1' });
          if (state.needConsent) return send({ error: 'Workspace AI processing consent required' }, 403);
          if (state.delayQuote) await new Promise(resolve => setTimeout(resolve, 500));
          state.quote = state.nextQuote ?? quote(); return send(state.quote);
        }
        if (url.pathname.endsWith('/ai-consent') && method === 'POST') { state.needConsent = false; return send({ consented: true }); }
        if (url.pathname.endsWith('/reading-checkout') && method === 'POST') {
          assert.deepEqual(body, { mode: 'full_v2', quote_id: state.quote.id, consent: { confirmed: true, contract_hash: state.quote.full_contract_hash } });
          if (state.pendingRevision) assert.equal(state.revisionSaved, true, 'Persist the uploaded revision before creating Checkout');
          state.quote.full_consent_confirmed = true;
          return send({ url: 'http://127.0.0.1:4185/checkout-fixture' });
        }
        if (url.pathname.endsWith('/ai-plan-readings') && method === 'POST') {
          assert.deepEqual(body, { mode: 'full_v2', file_id: 'file-1', quote_id: 'quote-1' });
          assert.equal(state.quote.status, 'paid'); assert.equal(state.quote.full_consent_confirmed, true);
          state.quote = { ...state.quote, status: 'processing', full_run_id: 'run-1' }; return send(run(), 202);
        }
        if (/\/takeoff-runs\/run-[12]$/.test(url.pathname) && method === 'GET') return send({ ...run(state.runStatus ?? (state.order?.status === 'ready_for_review' || state.quote?.status === 'complete' ? 'needs_review' : 'queued')), id: url.pathname.split('/').at(-1), ...(state.runStatus === 'waiting_budget' ? { not_before: '2099-01-01T00:00:00Z' } : {}) });
        unexpected.push(`${method} ${url.pathname}`); return send({ error: 'Unexpected synthetic request' }, 500);
      });
      const navigate = async (suffix = '', override = {}) => {
        // Finish the current scenario's read-only requests before replacing its
        // server fixture. WebKit reports an interrupted local fetch on unload.
        await page.waitForLoadState('networkidle');
        assert.deepEqual(unexpected, []); assert.deepEqual(external, []); assert.deepEqual(errors, []);
        // Each scenario owns a document. Close it before replacing the mock
        // server state, so WebKit's back/forward cache cannot keep its timers.
        page.removeAllListeners('pageerror');
        await page.close();
        page = await context.newPage();
        page.setDefaultTimeout(12_000);
        page.on('pageerror', error => errors.push(error.message));
        state = { owner: true, offline: false, quote: null, calls: [], ...override };
        await page.goto('http://127.0.0.1:4185/' + suffix);
        if (suffix.includes('draft=1')) await page.getByText(project.name, { exact: true }).click();
        await page.getByRole('region', { name: override.batch ? 'Selected files purchase' : 'Full reading purchase' }).waitFor();
        await page.waitForLoadState('networkidle');
      };
      const mutations = () => state.calls.filter(call => call.method === 'POST' && !call.path.endsWith('/download-url'));
      const starts = () => state.calls.filter(call => call.path.endsWith('/ai-plan-readings') && call.method === 'POST');
      const fullPosts = () => state.calls.filter(call => call.path.endsWith('/reading-quote') && call.method === 'POST');
      const panel = () => page.getByRole('region', { name: 'Full reading purchase' });
      const clickTwice = async locator => { await page.waitForFunction(button => !button.disabled, await locator.elementHandle()); await locator.evaluate(button => { button.click(); button.click(); }); };
      const returned = '?payment=returned&reading_mode=full_v2&workspace_id=workspace-1&project_id=project-1&file_id=file-1&quote_id=quote-1';
      const batchPanel = () => page.getByRole('region', { name: 'Selected files purchase' });
      const orderReturn = '?payment=returned&reading_mode=full_order&workspace_id=workspace-1&project_id=project-1&order_id=order-1&app=1';

      await navigate('?batch=1', { batch: true });
      await page.getByLabel('Include file-2.pdf in reading').check();
      await clickTwice(batchPanel().getByRole('button', { name: 'See price for selected PDFs' }));
      await batchPanel().getByText('$65.56', { exact: true }).waitFor();
      assert.deepEqual(state.calls.find(call => call.path.endsWith('/reading-order') && call.method === 'POST').body.file_ids.sort(), ['file-1', 'file-2']);
      assert.equal(state.calls.filter(call => call.path.endsWith('/reading-order') && call.method === 'POST').length, 1);
      assert.equal(fullPosts().length, 0, 'Selected PDFs use one order, never several client-side purchases');
      await batchPanel().getByText(/24 hours or longer/).waitFor();
      assert.equal(await batchPanel().getByRole('spinbutton').count(), 0);
      assert.equal(await batchPanel().getByText('synthetic-model', { exact: false }).count(), 0);
      await batchPanel().getByRole('checkbox').check();
      await clickTwice(batchPanel().getByRole('button', { name: 'Pay securely with Stripe' }));
      await page.waitForURL('**/checkout-fixture');
      assert.equal(state.calls.filter(call => call.path.endsWith('/reading-order-checkout')).length, 1);
      assert.equal(starts().length, 0);
      await page.goBack();
      await batchPanel().waitFor();
      await page.waitForLoadState('networkidle');
      assert.equal(await page.getByLabel('Include file-2.pdf in reading').isEnabled(), true, 'Back from Checkout releases the navigation lock');
      assert.equal(state.calls.filter(call => call.path.endsWith('/reading-order-checkout')).length, 1, 'Back only restores the saved purchase');
      assert.equal(starts().length, 0);

      await navigate('?batch=1', { batch: true, order: order(['file-1']) });
      await batchPanel().getByRole('checkbox').check();
      state.order.contract_hash = 'e'.repeat(64);
      await batchPanel().getByRole('button', { name: 'Pay securely with Stripe' }).click();
      await batchPanel().getByText('The files or price changed. Review the purchase and confirm again.').waitFor();
      assert.equal(await batchPanel().getByRole('checkbox').isChecked(), false);
      assert.deepEqual(mutations(), []);

      await navigate('?batch=1', { batch: true, order: order(undefined, { status: 'starting' }) });
      await page.getByLabel('Include file-2.pdf in reading').waitFor();
      await batchPanel().getByText('Payment confirmed. Preparing your reading…').waitFor();
      assert.equal(await page.getByLabel('Include file-2.pdf in reading').isChecked(), true, 'Reopening restores the paid batch containing the active PDF');
      await page.getByLabel('Include file-2.pdf in reading').uncheck();
      await batchPanel().getByRole('button', { name: 'See price for selected PDFs' }).waitFor();
      assert.equal(await page.getByLabel('Include file-2.pdf in reading').isChecked(), false, 'An intentional selection change never restores the old batch');
      assert.deepEqual(mutations(), []);

      await navigate(orderReturn, { batch: true, owner: false, order: order() });
      await batchPanel().getByText('Waiting for Stripe payment confirmation…').waitFor();
      assert.equal(await page.getByLabel('Include file-1.pdf in reading').isChecked(), true);
      assert.equal(await page.getByLabel('Include file-2.pdf in reading').isChecked(), true);
      assert.equal(state.calls.find(call => call.path === '/api/projects').workspace, 'workspace-1');
      assert.deepEqual(mutations(), []);
      state.order = order(undefined, { status: 'waiting' });
      state.order.items = state.order.items.map((item, index) => ({ ...item, status: 'processing', full_run_id: `run-${index + 1}` }));
      state.runStatus = 'waiting_budget';
      await batchPanel().getByRole('status').filter({ hasText: 'Waiting for processing capacity' }).waitFor();
      await batchPanel().getByText(/Estimated next window/).first().waitFor();
      await page.getByRole('article', { name: 'File file-1.pdf', exact: true }).getByText('Waiting for processing capacity', { exact: true }).waitFor();
      assert.deepEqual(mutations(), [], 'Waiting never retries or replaces a paid run from the browser');
      state.order.status = 'ready_for_review'; state.runStatus = 'needs_review';
      await batchPanel().getByText('Your results are ready to review').waitFor();
      await batchPanel().getByText(/2 pages need attention/).first().waitFor();
      await page.reload(); await batchPanel().getByText('Your results are ready to review').waitFor();
      assert.deepEqual(mutations(), [], 'Reload restores the same batch and every saved run');

      await navigate(orderReturn.replace('returned', 'canceled'), { batch: true, owner: false, order: order() });
      await batchPanel().getByText('Checkout was canceled. Your selection is saved; no reading has started.').waitFor();
      assert.deepEqual(mutations(), [], 'Cancel return cannot begin any file reading');

      await navigate('?batch=1', { batch: true });
      await page.locator('input[type="file"][accept=".pdf,application/pdf"]').first().setInputFiles(['first.pdf', 'retry.pdf', 'last.pdf'].map(name => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 SYNTHETIC ONLY') })));
      await page.getByRole('article', { name: 'File first.pdf', exact: true }).waitFor();
      await page.getByRole('article', { name: 'File last.pdf', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Retry failed uploads' }).click();
      await page.getByRole('article', { name: 'File retry.pdf', exact: true }).waitFor();
      assert.equal(state.calls.filter(call => call.path.endsWith('/documents/upload-url')).length, 4, 'Retry uploads only the failed source');
      assert.equal(await page.getByLabel(/Include .*\.pdf in reading/).count(), 5);
      assert.equal(starts().length, 0);
      assert.equal(state.calls.filter(call => /reading-order|reading-checkout/.test(call.path) && call.method === 'POST').length, 0, 'Uploading cannot create a purchase or call AI');

      await navigate();
      await page.getByText('Plan viewer and advanced reading tools', { exact: true }).click();
      await page.getByRole('button', { name: /^Run AI analysis \(owner workspace\)/ }).waitFor();
      await panel().getByRole('button', { name: 'Purchase full reading', exact: true }).click();
      await clickTwice(panel().getByRole('button', { name: 'Calculate full reading price' }));
      await panel().getByText('$32.78', { exact: true }).waitFor();
      assert.equal(fullPosts().length, 1);
      assert.equal(await panel().getByRole('spinbutton').count(), 0, 'Purchased budget is never a browser input');
      const pay = panel().getByRole('button', { name: 'Pay securely with Stripe' });
      assert.equal(await pay.isDisabled(), true);
      await panel().getByText(/starting this reading automatically after Stripe confirms payment/).waitFor();
      await panel().getByRole('checkbox').check();
      await clickTwice(pay);
      await page.waitForURL('**/checkout-fixture');
      assert.equal(state.calls.filter(call => call.path.endsWith('/reading-checkout')).length, 1);
      assert.equal(starts().length, 0);

      // Real App save queue: the PDF exists in the local recovered upload draft,
      // but not in remote app_state yet. Checkout must persist it first.
      await navigate('?app=1&draft=1&batch=1', { batch: true, pendingRevision: true, failSave: true });
      await batchPanel().getByRole('button', { name: 'See price for selected PDFs' }).click();
      await batchPanel().getByRole('checkbox').check();
      await batchPanel().getByRole('button', { name: 'Pay securely with Stripe' }).click();
      await batchPanel().getByText('Your selected PDFs could not be saved. Retry checkout to save them before opening Stripe.').waitFor();
      assert.equal(state.calls.filter(call => call.path.endsWith('/reading-order-checkout')).length, 0);
      state.failSave = false;
      await batchPanel().getByRole('button', { name: 'Pay securely with Stripe' }).click();
      await page.waitForURL('**/checkout-fixture');
      assert.equal(state.revisionSaved, true);
      assert.equal(state.calls.filter(call => call.path.endsWith('/reading-order-checkout')).length, 1);

      // Actual App boot restores the authorized workspace/project/original revision.
      await navigate(returned + '&app=1', { owner: false, quote: quote() });
      await panel().getByText('Waiting for Stripe payment confirmation…').waitFor();
      assert.equal(await panel().getByText('file-1.pdf · Revision 01').isVisible(), true);
      assert.equal(state.calls.find(call => call.path === '/api/projects').workspace, 'workspace-1');
      assert.deepEqual(mutations(), []);
      state.quote = quote({ status: 'paid', full_consent_confirmed: true });
      await panel().getByRole('button', { name: 'Start purchased reading' }).waitFor({ timeout: 10_000 });
      assert.deepEqual(mutations(), [], 'Webhook polling does not start AI');
      await clickTwice(panel().getByRole('button', { name: 'Start purchased reading' }));
      await page.getByRole('status', { name: 'Reading progress' }).waitFor();
      assert.equal(starts().length, 1);

      // A signed backend webhook may start/finish the same purchased run. The
      // browser follows persisted state without making any start request.
      await navigate(returned, { quote: quote({ full_consent_confirmed: true }) });
      await panel().getByText('Waiting for Stripe payment confirmation…').waitFor();
      state.quote = quote({ status: 'processing', full_run_id: 'run-1', full_consent_confirmed: true });
      await panel().getByText('Purchased reading in progress', { exact: true }).waitFor();
      assert.deepEqual(mutations(), []);
      state.quote = { ...state.quote, status: 'complete' };
      await panel().getByText('Purchased reading ready to review', { exact: true }).waitFor();
      await page.reload();
      await panel().getByText('Purchased reading ready to review', { exact: true }).waitFor();
      assert.deepEqual(mutations(), [], 'Completed purchase reload cannot replenish or repeat the run');

      await navigate(returned.replace('returned', 'canceled'), { quote: quote() });
      await panel().getByText('Checkout was canceled. This quote is saved; no reading has started.').waitFor();
      assert.deepEqual(mutations(), []);

      await navigate(returned, { quote: quote({ status: 'complete', full_run_id: 'run-1', full_consent_confirmed: true }), offline: true });
      await panel().getByRole('button', { name: 'Open purchased reading' }).waitFor();
      await page.getByRole('status', { name: 'Reading progress' }).waitFor();
      assert.deepEqual(mutations(), [], 'Saved evidence opens even with an offline worker');

      await navigate(returned, { quote: quote() });
      await panel().getByRole('checkbox').check();
      state.quote.full_contract_hash = 'b'.repeat(64);
      await panel().getByRole('button', { name: 'Pay securely with Stripe' }).click();
      await panel().getByText('The price or reading contract changed. Review it and confirm again.').waitFor();
      assert.equal(await panel().getByRole('checkbox').isChecked(), false);
      assert.deepEqual(mutations(), []);

      await navigate(returned, { quote: quote() });
      await panel().getByText('Waiting for Stripe payment confirmation…').waitFor();
      state.quote = quote({ status: 'paid', full_consent_confirmed: true });
      await panel().getByRole('button', { name: 'Refresh full reading price' }).click();
      await panel().getByRole('button', { name: 'Start purchased reading' }).waitFor();
      assert.deepEqual(mutations(), [], 'A late payment wins over repricing');

      await navigate(returned, { quote: quote({ status: 'revoked', full_run_id: 'run-1' }) });
      await panel().getByText('Payment access revoked. No new reading can start.').waitFor();
      assert.equal(await panel().getByRole('button', { name: /Start purchased|Open purchased|Pay securely|Get a new full reading price/ }).count(), 0);
      assert.deepEqual(mutations(), []);

      // A closed Checkout without a run may be explicitly replaced. Neither
      // its prior approval nor payment return URL authorizes the new quote.
      const closed = quote({ status: 'revoked', full_consent_confirmed: true });
      await navigate(returned.replace('returned', 'canceled'), { quote: closed, nextQuote: quote({ id: 'quote-2', full_contract_hash: 'c'.repeat(64) }) });
      await clickTwice(panel().getByRole('button', { name: 'Get a new full reading price' }));
      await panel().getByRole('checkbox').waitFor();
      assert.equal(fullPosts().length, 1);
      assert.equal(closed.status, 'revoked', 'New purchase cannot restore the previous quote');
      assert.equal(await panel().getByRole('checkbox').isChecked(), false);
      assert.equal(await panel().getByRole('button', { name: 'Pay securely with Stripe' }).isDisabled(), true);
      assert.equal(starts().length, 0);
      await panel().getByRole('checkbox').check();
      await panel().getByRole('button', { name: 'Pay securely with Stripe' }).click();
      await page.waitForURL('**/checkout-fixture');
      assert.equal(state.calls.filter(call => call.path.endsWith('/reading-checkout')).length, 1);
      assert.equal(state.calls.find(call => call.path.endsWith('/reading-checkout')).body.quote_id, 'quote-2');

      // Reconcile the saved state before issuing a replacement request.
      await navigate(returned, { quote: quote({ status: 'revoked' }) });
      await panel().getByRole('button', { name: 'Get a new full reading price' }).waitFor();
      state.quote = quote({ status: 'paid', full_consent_confirmed: true });
      await panel().getByRole('button', { name: 'Get a new full reading price' }).click();
      await panel().getByRole('button', { name: 'Start purchased reading' }).waitFor();
      assert.deepEqual(mutations(), [], 'A recovered payment wins over the replacement quote');

      await navigate(returned, { quote: quote({ status: 'paid', full_consent_confirmed: true }), failRead: true });
      await panel().getByText('Synthetic purchase read unavailable').waitFor();
      await panel().getByRole('button', { name: 'Retry loading purchase' }).click();
      await panel().getByRole('button', { name: 'Start purchased reading' }).waitFor();
      assert.deepEqual(mutations(), []);

      await navigate('?batch=1', { batch: true, needConsent: true });
      await batchPanel().getByRole('button', { name: 'See price for selected PDFs' }).click();
      await page.getByRole('button', { name: 'Approve AI plan reading', exact: true }).waitFor();
      assert.equal(starts().length, 0);

      await navigate('', { delayQuote: true });
      await panel().getByRole('button', { name: 'Purchase full reading' }).click();
      await panel().getByRole('button', { name: 'Calculate full reading price' }).click();
      await page.getByRole('button', { name: 'Select newer revision' }).click();
      await panel().getByText('file-2.pdf · Revision 02').waitFor();
      await page.waitForTimeout(700);
      assert.equal(await panel().getByText('$32.78', { exact: true }).count(), 0, 'Old revision response cannot populate the new revision');
      assert.equal(starts().length, 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No horizontal overflow');
      assert.deepEqual(unexpected, []); assert.deepEqual(external, []); assert.deepEqual(errors, []);
      console.log(`PASS ${browserName}: multi-upload/retry, single batch Checkout, selection recovery, immutable consent, save failure/retry, passive return, capacity wait/resume, all-file pending results, legacy purchase recovery, zero external traffic`);
    } finally { await browser.close(); }
  }
} finally {
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  const cleanup = path.resolve(root);
  if (!cleanup.startsWith(path.resolve(repo) + path.sep) || !path.basename(cleanup).startsWith('.full-purchase-check-')) throw new Error('Unsafe fixture cleanup');
  await rm(cleanup, { recursive: true, force: true });
}
