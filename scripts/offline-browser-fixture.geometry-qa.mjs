import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../deliverables/offline-browser');
const fixtureUrl = 'http://127.0.0.1:4187/offline-browser-fixture.html';
const report = { fixtureOnly: true, paidCalls: 0, separateFrom: 'offline-browser-report.json (13 earlier assertions unchanged)', backend: 'fetch/localStorage mocks; real local reviewMeasurement function; no SQL or external services', startedAt: new Date().toISOString(), assertions: [], externalRequestsBlocked: [], network: [], exceptions: [], screenshots: [], mockRequests: [] };
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
  await navigate('reset'); await navigate('geometry');
  await wait("document.body.textContent.includes('Source fingerprint and page dimensions verified')", 'fingerprint preview');
  await assert("document.querySelector('canvas[aria-label=\"Private PDF sheet 1\"]')?.width > 0", 'actual PDF renders after fingerprint and page frame verification');
  await click('Find native PDF candidates');
  await wait("document.querySelector('summary')?.textContent.includes('Choose candidate region')", 'native candidates');
  await evaluate("document.querySelector('summary').click()"); await click('quantity undetermined');
  await assert("document.body.textContent.includes('Trace the actual physical element') && document.body.textContent.includes('No reviewed elements saved') && window.__offlineFixture.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/measurements')).length===0", 'native bbox selection does not create a quantity');
  await setField('Element label', 'Synthetic room actual boundary'); await setField('Stable region ID', 'fixture-room'); await setField('Trade ID', 'finishes'); await setField('Distinct physical element ID', 'fixture-room-floor');
  await setField('Source evidence and interpretation', 'Synthetic page 1 actual room boundary; no real customer evidence.', 0, 'textarea');
  await click('Save measurement review');
  await wait("document.body.textContent.includes('Trace the actual element inside')", 'untraced save denied');
  await assert("window.__offlineFixture.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/measurements')).length===0", 'a candidate extent cannot be saved as traced measurement');
  await setField('Geometry', 'rectangle', 0, 'select'); await click('Trace actual element'); await point(0.2, 0.2); await point(0.6, 0.6);
  await setField('Boundary method', 'verified_rectangular_surface', 0, 'select');
  await setField('Explain which physical boundary', 'I verified the actual rectangular floor outline; selected bbox is larger than the physical boundary.', 0, 'textarea');
  await check('I checked the actual boundary');
  for (let index = 0; index < 2; index++) {
    await click('Trace reference line', index); await point(0.2, 0.2); await point(index === 0 ? 0.4 : 0.2, index === 0 ? 0.2 : 0.4);
    await setField('Source ID', index === 0 ? 'north-half-span' : 'west-half-span', index);
    await setField('Physical length shown', '4', index);
    await setField('Exact visible dimension', index === 0 ? 'North half-span shows 4 ft in the synthetic drawing.' : 'West half-span independently shows 4 ft in the synthetic drawing.', index, 'textarea');
    await check('This is distinct evidence', index);
  }
  await check('I reviewed the actual traced geometry'); await check('I identified this distinct physical element'); await check('I checked duplicates');
  await setField('Review decision', 'accepted', 0, 'select'); await click('Save measurement review');
  await wait("document.body.textContent.includes('Reviewed quantity saved by the server')", 'validated rectangle accepted');
  await assert("window.__offlineFixture.measurements[0].quantity === 64 && window.__offlineFixture.measurements[0].unit === 'SF' && document.body.textContent.includes('64 SF')", 'two independent references produce deterministic 64 SF for the actual trace');
  await assert("(() => { const body=window.__offlineFixture.requests.find(r=>r.method==='POST'&&r.path.endsWith('/measurements')).body;return !('quantity' in body)&&body.calibrationEvidence.length===2&&body.boundaryEvidence.reviewed&&body.geometry.points[0][0]===0.2&&body.geometry.points[1][0]===0.6; })()", 'browser submits reviewed geometry and evidence without an invented quantity');
  await assert("document.body.textContent.includes('selected elements only') && document.body.textContent.includes('price pending')", 'accepted geometry does not claim whole scope or a price');
  await evaluate("document.querySelector('form').scrollIntoView({block:'start'})"); await screenshot('07-plan-geometry-calibration');
  await navigate('geometry'); await wait("document.body.textContent.includes('64 SF')", 'saved measurement reload');
  await assert("window.__offlineFixture.measurements.length===1 && document.body.textContent.includes('revision 1')", 'accepted measurement recovers once after page reload');
  await navigate('geometry-viewer'); await wait("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Save measurement review'))?.closest('fieldset').disabled", 'readonly geometry');
  await assert("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Save measurement review')).closest('fieldset').disabled", 'viewer may inspect geometry but cannot submit a review');

  await navigate('pricing-viewer');
  await assert("!document.querySelector('section[aria-label=\"Owner RoughBid service pricing preview\"]')", 'service pricing preview is hidden without platform-owner access');
  await navigate('pricing'); await click('RoughBid service pricing preview');
  await assert("document.body.textContent.includes('Inputs pending') && document.body.textContent.includes('The construction estimate has its own')", 'RoughBid fee is separate from construction price and starts pending');
  await evaluate("[...document.querySelectorAll('label')].find(l=>l.textContent.includes('Monthly membership')).querySelector('input[type=radio]').click()");
  await wait("document.body.textContent.includes('Monthly prices and target margins are pending')", 'monthly pending policy');
  await assert("document.body.textContent.includes('Inputs pending') && [...document.querySelectorAll('input')].filter(i=>i.inputMode==='decimal').every(i=>i.value==='')", 'monthly price and margin remain unknown without sourced parameters');
  await screenshot('08-saas-monthly-pending');
  await evaluate("[...document.querySelectorAll('label')].find(l=>l.textContent.trim()==='Per document').querySelector('input[type=radio]').click()");
  await setField('Description', 'Offline hypothetical processing forecast'); await setField('Unit count', '1'); await setField('Unit cost (USD)', '1');
  await setField('Evidence basis', 'reviewed_forecast', 0, 'select'); await setField('Source / usage-ledger reference', 'offline-fixture-hypothetical-only'); await setField('Cost or rate version', 'offline-fixture-v1'); await setField('Evidence date', '2026-10-02');
  await check('I have covered every applicable technical cost'); await setField('Fixed fee (USD)', '0'); await setField('Variable fee (%)', '0'); await setField('Payment method / fee source', 'offline hypothetical no-fee input; not a real contract');
  await wait("document.body.textContent.includes('Proposal ready for review')", 'local per-document calculation');
  await assert("document.body.textContent.includes('Contains forecast costs') && window.__offlineFixture.requests.length===0", 'hypothetical sourced forecast calculates locally without API or charge');
  await click('Show calculation record');
  await assert("document.querySelector('textarea[aria-label=\"Auditable service pricing record\"]').value.includes('not_enabled_by_preview')", 'auditable preview never activates commercial charging');
  await evaluate("document.querySelector('section[aria-label=\"Service pricing calculation result\"]').scrollIntoView({block:'center'})"); await screenshot('09-saas-local-preview-record');
  if (report.exceptions.length) throw new Error('Uncaught browser exceptions: ' + report.exceptions.join('; '));
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; await screenshot('geometry-failure').catch(() => {}); console.error(error.stack); }
finally { report.finishedAt = new Date().toISOString(); report.mockRequests.push(...await evaluate('window.__offlineFixture?.requests ?? []').catch(() => [])); await fs.writeFile(path.join(output,'offline-browser-geometry-report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify({passed:report.passed,assertions:report.assertions.length,externalRequestsBlocked:report.externalRequestsBlocked.length,exceptions:report.exceptions.length,output},null,2));socket.close(); }
if (!report.passed) process.exitCode=1;
