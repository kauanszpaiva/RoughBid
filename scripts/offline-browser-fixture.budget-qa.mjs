import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../deliverables/offline-browser');
const fixtureUrl = 'http://127.0.0.1:4187/offline-browser-fixture.html';
const report = { fixtureOnly: true, paidCalls: 0, separateFrom: '13 original and 13 geometry/pricing assertions remain unchanged', backend: 'actual PlansPage and ConstructionBudgetPanel with mocked budget API/localStorage; accepted 64 SF previously calculated by real local reviewMeasurement; no SQL or supplier calls', startedAt: new Date().toISOString(), assertions: [], externalRequestsBlocked: [], network: [], exceptions: [], screenshots: [], mockRequests: [] };
await fs.mkdir(output, { recursive: true });
const targets = await (await fetch('http://127.0.0.1:9317/json/list')).json();
const target = targets.find(item => item.type === 'page' && (item.url === 'about:blank' || item.url.startsWith(fixtureUrl)));
if (!target) throw new Error('An isolated fixture tab was not found.');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let sequence = 0; const pending = new Map(); const listeners = new Map();
socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.id) { const waiting = pending.get(message.id); pending.delete(message.id); if (waiting) { clearTimeout(waiting.timer); message.error ? waiting.reject(new Error(JSON.stringify(message.error))) : waiting.resolve(message.result); } } else for (const listener of listeners.get(message.method) ?? []) listener(message.params); });
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout ' + method)); }, 20_000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
const on = (method, handler) => listeners.set(method, [...(listeners.get(method) ?? []), handler]);
const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
on('Fetch.requestPaused', event => { const url = new URL(event.request.url); const allowed = url.origin === 'http://127.0.0.1:4187' || ['data:', 'blob:'].includes(url.protocol); if (!allowed) report.externalRequestsBlocked.push(event.request.url); void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId: event.requestId } : { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => {}); });
on('Network.requestWillBeSent', event => report.network.push({ method: event.request.method, url: event.request.url }));
on('Runtime.exceptionThrown', event => report.exceptions.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text));
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(expression, label) { const start = Date.now(); while (Date.now() - start < 20_000) { if (await evaluate('Boolean(' + expression + ')')) return; await sleep(100); } throw new Error('Timeout ' + label); }
async function assert(expression, label) { const passed = Boolean(await evaluate(expression)); report.assertions.push({ label, passed }); if (!passed) throw new Error('Assertion failed: ' + label); console.log('PASS ' + label); }
async function navigate(view) { report.mockRequests.push(...await evaluate('window.__offlineFixture?.requests ?? []').catch(() => [])); await evaluate('window.__offlineFixtureReady=false'); await send('Page.navigate', { url: fixtureUrl + '?view=' + view }); await wait("window.__offlineFixtureReady === true && location.search === '?view=" + view + "'", 'fixture mounted'); }
async function click(text, index = 0) { const find = "[...document.querySelectorAll('button')].filter(b => b.textContent.includes(" + JSON.stringify(text) + '))[' + index + ']'; await wait(find + ' && !' + find + '.disabled', 'button ' + text); await evaluate(find + '.click()'); }
async function setField(label, value, index = 0, elementType = 'input') { const find = "[...document.querySelectorAll('label')].filter(l=>l.textContent.trim().startsWith(" + JSON.stringify(label) + '))[' + index + "].querySelector('" + elementType + "')"; await evaluate("(() => { const element=" + find + ";const prototype=element instanceof HTMLSelectElement?HTMLSelectElement.prototype:element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(element," + JSON.stringify(value) + ");element.dispatchEvent(new Event('" + (elementType === 'select' ? 'change' : 'input') + "',{bubbles:true})); })()"); }
async function check(label, index = 0) { await evaluate("[...document.querySelectorAll('label')].filter(l=>l.textContent.includes(" + JSON.stringify(label) + '))[' + index + "].querySelector('input[type=checkbox]').click()"); }
async function point(x, y) { await evaluate("(() => { const svg=document.querySelector('svg[aria-label=\"Drawing measurement overlay\"]');const bounds=svg.getBoundingClientRect();const event=new MouseEvent('click',{bubbles:true});Object.defineProperties(event,{clientX:{value:bounds.left+bounds.width*" + x + '},clientY:{value:bounds.top+bounds.height*' + y + '}});svg.dispatchEvent(event); })()'); }
async function screenshot(name) { const file = path.join(output, name + '.png'); const data = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await fs.writeFile(file, Buffer.from(data.data, 'base64')); report.screenshots.push(file); }

try {
  await navigate('plans');
  await wait("document.querySelector('section[aria-label=\"Construction catalog and evidenced budget\"]')?.textContent.includes('64 SF')", 'accepted geometry reaches connected budget');
  await assert("document.querySelector('section[aria-label=\"Construction catalog and evidenced budget\"]').textContent.includes('64 SF') && document.body.textContent.includes('Scope coverage is partial')", 'actual PlansPage budget receives accepted 64 SF evidence with partial scope');
  await setField('Service with matching units', 'RB-FLOOR-003', 0, 'select');
  await assert("document.body.textContent.includes('Location pending. No price is verified') && window.__offlineFixture.quotes?.length !== 1", 'missing project location and product quote do not produce a live price');
  await click('Calculate & save budget review');
  await wait("document.body.textContent.includes('Saved construction-budget review') && window.__offlineFixture.snapshots?.length === 1", 'direct snapshot response accepted');
  await assert("window.__offlineFixture.snapshots[0].result.totalUsd === null && window.__offlineFixture.snapshots[0].result.lines[0].quantity === 64 && document.querySelector('section[aria-label=\"Construction catalog and evidenced budget\"]').textContent.includes('documented_material_quote_required') && !document.querySelector('section[aria-label=\"Construction catalog and evidenced budget\"]').textContent.includes('$0.00')", 'direct saved snapshot keeps the 64 SF and missing prices pending rather than zero');
  await assert("(() => { const posts=window.__offlineFixture.requests.filter(r=>r.path.endsWith('/construction-budget')&&r.method==='POST');const body=posts[0].body;return posts.length===1 && body.selections.length===1 && !('quantity' in body.selections[0]) && body.quoteIds.length===0 && body.runId==='offline-geometry-run';})()", 'budget mutation references one accepted measurement without browser quantity or undocumented quote');
  await click('View evidence and calculation');
  await assert("(() => { const saved=JSON.parse(document.querySelector('textarea[aria-label=\"Saved construction-budget calculation and evidence\"]').value);return saved.result.trace[0].acceptedQuantity===64 && saved.result.trace[0].calibration.verificationStatus==='verified' && saved.result.trace[0].geometry.points[0][0]===0.2 && saved.result.totalUsd===null;})()", 'saved review exposes accepted geometry, calibrated quantity and unresolved price evidence');
  await evaluate("[...document.querySelectorAll('h3')].find(h=>h.textContent==='Saved construction-budget review').closest('article').scrollIntoView({block:'start'})"); await screenshot('10-budget-saved-pending-quotes');
  await navigate('plans');
  await wait("document.body.textContent.includes('Open saved evidence')", 'summary after browser reload');
  await assert("window.__offlineFixture.snapshots.length===1 && document.body.textContent.includes('Complete construction price') && document.body.textContent.includes('Its summary does not prove a zero price')", 'mocked saved review recovers once after reload and distinguishes unloaded evidence from zero cost');
  await click('Open saved evidence');
  await wait("!document.body.textContent.includes('Open saved evidence') && document.body.textContent.includes('Synthetic reviewed floor')", 'specific snapshot lazy evidence load');
  await assert("window.__offlineFixture.requests.some(r=>r.method==='GET'&&r.path.endsWith('/construction-budget')&&r.query.startsWith('?snapshot_id=')) && window.__offlineFixture.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/construction-budget')).length===0 && document.body.textContent.includes('64 SF')", 'lazy evidence reload fetches the exact saved snapshot without replaying its mutation');
  await evaluate("[...document.querySelectorAll('h3')].find(h=>h.textContent==='Saved construction-budget review').closest('article').scrollIntoView({block:'start'})"); await screenshot('11-budget-recovered-evidence');
  await navigate('viewer'); await wait("document.body.textContent.includes('Read-only access. Accepted evidence')", 'viewer budget');
  await assert("!([...document.querySelectorAll('button')].find(b=>b.textContent.includes('Calculate & save budget review'))) && [...document.querySelectorAll('label')].find(l=>l.textContent.startsWith('Service with matching units')).querySelector('select').disabled", 'read-only project role can inspect the budget but cannot save or select service inputs');
  if (report.exceptions.length) throw new Error('Uncaught browser exceptions: ' + report.exceptions.join('; '));
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; await screenshot('budget-failure').catch(() => {}); console.error(error.stack); }
finally { report.finishedAt=new Date().toISOString();report.mockRequests.push(...await evaluate('window.__offlineFixture?.requests ?? []').catch(()=>[]));await fs.writeFile(path.join(output,'offline-browser-budget-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,assertions:report.assertions.length,externalRequestsBlocked:report.externalRequestsBlocked.length,exceptions:report.exceptions.length,output},null,2));socket.close(); }
if (!report.passed) process.exitCode=1;
