import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(repoRoot, '../deliverables/offline-browser');
const fixtureUrl = 'http://127.0.0.1:4187/offline-browser-fixture.html';
const report = { fixtureOnly: true, paidCalls: 0, backend: 'browser fetch mocks and localStorage only', startedAt: new Date().toISOString(), assertions: [], externalRequestsBlocked: [], network: [], exceptions: [], screenshots: [], mockRequests: [] };
await fs.mkdir(output, { recursive: true });

class CDP {
  constructor(socket) { this.socket = socket; this.sequence = 0; this.pending = new Map(); this.listeners = new Map();
    socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); if (message.id) { const request = this.pending.get(message.id); this.pending.delete(message.id); if (request) { clearTimeout(request.timer); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); } } else for (const listener of this.listeners.get(message.method) ?? []) listener(message.params); });
  }
  on(event, listener) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); }
  send(method, params = {}) { const id = ++this.sequence; return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20_000); this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expression) { const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; }
}
const targets = await (await fetch('http://127.0.0.1:9317/json/list')).json();
const target = targets.find(item => item.type === 'page' && (item.url === 'about:blank' || item.url.startsWith(fixtureUrl)));
if (!target) throw new Error('The isolated headless about:blank tab was not found.');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
const cdp = new CDP(socket);
cdp.on('Fetch.requestPaused', (event) => {
  const url = new URL(event.request.url);
  if (url.origin === 'http://127.0.0.1:4187' || ['data:', 'blob:'].includes(url.protocol)) {
    void cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
  } else {
    report.externalRequestsBlocked.push(event.request.url);
    void cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
  }
});
cdp.on('Network.requestWillBeSent', (event) => report.network.push({ url: event.request.url, method: event.request.method }));
cdp.on('Runtime.exceptionThrown', (event) => report.exceptions.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text));
await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(expression, label, timeout = 20_000) { const started = Date.now(); while (Date.now() - started < timeout) { if (await cdp.evaluate(`Boolean(${expression})`)) return; await sleep(100); } throw new Error(`Timed out: ${label}`); }
async function assert(expression, label) { const passed = Boolean(await cdp.evaluate(expression)); report.assertions.push({ label, passed }); if (!passed) throw new Error(`Assertion failed: ${label}`); console.log(`PASS ${label}`); }
async function click(text, exact = true) { const match = exact ? `button.textContent.trim() === ${JSON.stringify(text)}` : `button.textContent.includes(${JSON.stringify(text)})`; await wait(`[...document.querySelectorAll('button')].some(button => (${match}) && !button.disabled)`, `button ready: ${text}`); await cdp.evaluate(`(() => { const element = [...document.querySelectorAll('button')].find(button => ${match}); if (!element || element.disabled) throw new Error('Button unavailable: ' + ${JSON.stringify(text)}); element.click(); })()`); }
async function fill(selector, value) { await cdp.evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!input) throw new Error('Input not found'); const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`); }
async function navigate(query) { report.mockRequests.push(...await cdp.evaluate('window.__offlineFixture?.requests ?? []').catch(() => [])); await cdp.evaluate('window.__offlineFixtureReady = false'); await cdp.send('Page.navigate', { url: `${fixtureUrl}${query}` }); await wait(`window.__offlineFixtureReady === true && location.href === ${JSON.stringify(`${fixtureUrl}${query}`)}`, 'fixture module mount'); }
async function screenshot(name) { const file = path.join(output, `${name}.png`); const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await fs.writeFile(file, Buffer.from(result.data, 'base64')); report.screenshots.push(file); }
async function upload(selector, file) { const doc = await cdp.send('DOM.getDocument'); const found = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector }); if (!found.nodeId) throw new Error(`File input unavailable: ${selector}`); await cdp.send('DOM.setFileInputFiles', { nodeId: found.nodeId, files: [file] }); }

try {
  await navigate('?view=reset');
  await navigate('?view=auth#error=access_denied&error_code=otp_expired&error_description=private-fixture-value');
  await wait("document.body.textContent.includes('This sign-in link has expired')", 'expired-link recovery');
  await assert("!document.body.textContent.includes('private-fixture-value')", 'callback error values are not exposed');
  await fill('input[name=email]', 'not-an-email');
  await click('Sign In to Workspace');
  await assert("window.__offlineFixture.requests.filter(r => r.path === '/api/auth/magic-link').length === 0", 'invalid email does not dispatch a login request');
  await fill('input[name=email]', ' Estimator@Example.test ');
  await click('Sign In to Workspace');
  await wait("document.body.textContent.includes('Check your email')", 'accepted mocked sign-in');
  await assert("window.__offlineFixture.requests.find(r => r.path === '/api/auth/magic-link').body.email === 'estimator@example.test'", 'email is normalized before the mocked request');
  await screenshot('01-auth-local-accepted');

  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const title of ['A1 — Fixture floor plan', 'A2 — Fixture specifications']) {
    const page = pdf.addPage([612, 792]); page.drawText(title.replace('—', '-'), { x: 40, y: 740, size: 20, font });
    page.drawRectangle({ x: 120, y: 340, width: 360, height: 300, borderColor: rgb(0.1, 0.2, 0.3), borderWidth: 3 });
    page.drawText('Synthetic room: 12 ft x 10 ft', { x: 140, y: 670, size: 16, font }); page.drawText('Not a real customer plan. Independent verification and price are pending.', { x: 40, y: 90, size: 10, font });
  }
  const pdfPath = path.join(output, 'offline-floor-plan.pdf'); await fs.writeFile(pdfPath, await pdf.save());
  await navigate('?view=plans');
  await wait("document.body.textContent.includes('No plan uploaded')", 'empty plan upload page');
  await upload('input[type=file][accept=".pdf,application/pdf"]', pdfPath);
  await wait("document.body.textContent.includes('offline-floor-plan.pdf') && JSON.parse(localStorage.getItem('roughbid-offline-fixture-project')).revisions[0].processingStatus === 'ready'", 'private PDF upload mock completed');
  await assert("window.__offlineFixture.requests.some(r => r.path.endsWith('/documents/upload-url')) && window.__offlineFixture.requests.some(r => r.path === '/offline-storage/pdf' && r.method === 'PUT') && window.__offlineFixture.requests.some(r => r.path.endsWith('/complete'))", 'PDF follows reserve, upload and completion endpoints');
  await wait("[...document.querySelectorAll('label')].some(l => l.textContent.includes('Full Takeoff V2'))", 'Full V2 entitlement control');
  await cdp.evaluate("[...document.querySelectorAll('label')].find(l => l.textContent.includes('Full Takeoff V2')).querySelector('input').click()");
  await click('Start Full Takeoff V2', false);
  await wait("document.body.textContent.includes('saved progress remains recoverable') || window.__offlineFixture.fullRun", 'durable mock saved');
  await assert("window.__offlineFixture.requests.find(r => r.path.endsWith('/ai-plan-readings')).body.mode === 'full_v2'", 'Full reading is explicitly selected and saved through the product API');
  await click('AI Plan Assistant');
  await wait("document.body.textContent.includes('1/20 checkpoints saved')", 'saved checkpoint progress');
  await screenshot('02-plan-durable-progress');
  await click('Cancel reading');
  await wait("document.body.textContent.includes('Full Takeoff V2 was cancelled')", 'explicit cancellation saved');
  await assert("window.__offlineFixture.requests.filter(r => r.path.endsWith('/cancel')).length === 1", 'cancel is dispatched once');
  await click('Resume from saved stages');
  await wait("document.body.textContent.includes('Full Takeoff V2: processing')", 'resume saved stages');
  await cdp.evaluate("window.__offlineFixture.advancePlan('needs_review')");
  await cdp.evaluate('window.__offlineFixtureReady = false'); await cdp.send('Page.reload'); await wait('window.__offlineFixtureReady === true', 'reload fixture');
  await click('AI Plan Assistant');
  await wait("document.body.textContent.includes('Full Takeoff V2: needs review')", 'recover saved Full run after reload');
  await cdp.evaluate("[...document.querySelectorAll('summary')].find(e => e.textContent.includes('Physical sheet 1')).click()");
  await cdp.evaluate("[...document.querySelectorAll('summary')].find(e => e.textContent.startsWith('inventory') && e.textContent.includes('succeeded')).click()");
  await wait("document.body.textContent.includes('Fixture sheet A1 shows a rectangular room')", 'lazy persisted checkpoint evidence');
  await assert("document.body.textContent.includes('Source excerpt: A1:') && document.body.textContent.includes('quantities and prices are not verified')", 'sheet evidence is traceable and unresolved measures/prices are explicit');
  await screenshot('03-plan-saved-evidence');

  await navigate('?view=plans');
  const png = await cdp.evaluate("(() => { const canvas = document.createElement('canvas'); canvas.width=800; canvas.height=600; const ctx=canvas.getContext('2d'); ctx.fillStyle='#eee';ctx.fillRect(0,0,800,600);ctx.fillStyle='#64748b';ctx.fillRect(120,90,500,370);ctx.fillStyle='#111';ctx.font='24px sans-serif';ctx.fillText('Synthetic fixture wall; no physical scale',30,550);return canvas.toDataURL('image/png').split(',')[1]; })()");
  const pngPath = path.join(output, 'offline-wall-photo.png'); await fs.writeFile(pngPath, Buffer.from(png, 'base64'));
  await wait("!document.querySelector('input[aria-label=\"Select construction photos\"]').disabled", 'photo capability available');
  await upload('input[aria-label="Select construction photos"]', pngPath);
  await click('Upload photos privately');
  await wait("document.body.textContent.includes('photos are verified in private storage')", 'private photo upload mock');
  await click('Start photo reading');
  await wait("document.body.textContent.includes('Photo reading: processing')", 'durable photo mock saved');
  await cdp.evaluate('window.__offlineFixture.advancePhoto()');
  await click('Reload saved runs');
  await wait("document.body.textContent.includes('Physical quantity is undetermined.')", 'unscaled photo remains quantity pending');
  await assert("document.body.textContent.includes('Pricing: missing source prices') && document.body.textContent.includes('No measurement has been approved')", 'photo observation never fabricates measure or price');
  await click('Load private source photo');
  await wait("document.querySelector('img[alt=\"Private construction source photo 1\"]')", 'private source preview with regions');
  await cdp.evaluate("document.querySelector('section[aria-label=\"Photo takeoff\"]').scrollIntoView()");
  await screenshot('04-photo-unscaled-evidence');

  await cdp.evaluate("(() => { const select = document.querySelector('select[aria-label=\"Review decision for Visible wall surface\"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'approved');select.dispatchEvent(new Event('change',{bubbles:true})); })()");
  await wait("document.querySelector('input[aria-label=\"Reviewed quantity for Visible wall surface\"]')", 'human review controls');
  await cdp.evaluate("(() => { const select = [...document.querySelectorAll('label')].find(l => l.textContent.startsWith('Measurement method')).querySelector('select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'instrument_measurement');select.dispatchEvent(new Event('change',{bubbles:true})); })()");
  await fill('input[aria-label="Reviewed quantity for Visible wall surface"]', '120');
  await cdp.evaluate("(() => { const select=[...document.querySelectorAll('label')].find(l=>l.textContent.startsWith('Unit')).querySelector('select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'SF');select.dispatchEvent(new Event('change',{bubbles:true}));const input=[...document.querySelectorAll('label')].find(l=>l.textContent.startsWith('Physical object identity')).querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'fixture-wall-a');input.dispatchEvent(new Event('input',{bubbles:true})); })()");
  await fill('section[aria-label="Photo observations"] textarea', 'Offline fixture instrument area reading on wall-a; no real customer measurement.');
  await cdp.evaluate("[...document.querySelectorAll('label')].find(l=>l.textContent.includes('I verified this instrument reading')).querySelector('input').click();[...document.querySelectorAll('label')].find(l=>l.textContent.includes('I resolved the listed uncertainties')).querySelector('input').click()");
  await click('Save human measurement review');
  await wait("document.body.textContent.includes('Human measurement review saved')", 'documented human review mock saved');
  await assert("window.__offlineFixture.requests.find(r=>r.path.endsWith('/review')).body.references[0].region.surfaceKey === 'wall-a'", 'instrument reference is bound to the originating photo region');
  await assert("document.body.textContent.includes('fixture-wall-a: 120 SF') && document.body.textContent.includes('Pricing remains missing.')", 'reviewed photo measure is displayed while its price remains pending');
  await cdp.evaluate("document.querySelector('section[aria-label=\"Human-reviewed photo measurements\"]').scrollIntoView({block:'center'})");
  await screenshot('05-photo-human-reference');

  await navigate('?view=viewer');
  await wait("document.querySelector('input[aria-label=\"Select construction photos\"]')", 'viewer page');
  await assert("[...document.querySelectorAll('input[type=file]')].every(input => input.disabled)", 'viewer cannot upload plan or photos');
  await assert("[...document.querySelectorAll('button')].filter(b => /Start Full Takeoff|Start photo reading|Save human measurement review/.test(b.textContent)).every(button => button.disabled)", 'viewer cannot start or approve jobs');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await navigate('?view=plans');
  await wait("document.querySelector('section[aria-label=\"Photo takeoff\"]')", 'mobile photo panel');
  await assert('document.documentElement.scrollWidth <= window.innerWidth + 1', 'mobile layout has no horizontal overflow');
  await cdp.evaluate("document.querySelector('section[aria-label=\"Photo takeoff\"]').scrollIntoView()");
  await screenshot('06-mobile-photo-flow');
  if (report.exceptions.length) throw new Error(`Uncaught browser exceptions: ${report.exceptions.join('; ')}`);
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.message;
  await screenshot('failure').catch(() => {});
  console.error(error.stack);
} finally {
  report.finishedAt = new Date().toISOString();
  report.mockRequests.push(...await cdp.evaluate('window.__offlineFixture?.requests ?? []').catch(() => []));
  await fs.writeFile(path.join(output, 'offline-browser-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, assertions: report.assertions.length, externalRequestsBlocked: report.externalRequestsBlocked.length, exceptions: report.exceptions.length, output }, null, 2));
  socket.close();
}
if (!report.passed) process.exitCode = 1;
