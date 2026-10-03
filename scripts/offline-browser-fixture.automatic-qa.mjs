import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../deliverables/offline-browser');
const fixtureUrl = 'http://127.0.0.1:4187/offline-browser-fixture.html';
const report = { fixtureOnly: true, paidCalls: 0, separateFrom: '34 earlier browser assertions are preserved; this report covers the new automatic proposal flow', backend: 'actual product components and real local kamaiCandidates DTO normalization; upstream geometry/provider/jobs/persistence/budget API are local mocks; no SQL or provider calls', startedAt: new Date().toISOString(), assertions: [], externalRequestsBlocked: [], network: [], exceptions: [], screenshots: [], mockRequests: [] };
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

async function upload(selector,file) { const document=await send('DOM.getDocument');const node=await send('DOM.querySelector',{nodeId:document.root.nodeId,selector});if(!node.nodeId)throw new Error('Missing upload input '+selector);await send('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[file]}); }
async function selectValue(selector,value) { await evaluate("(() => {const element=document.querySelector("+JSON.stringify(selector)+");Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(element,"+JSON.stringify(value)+");element.dispatchEvent(new Event('change',{bubbles:true}));})()"); }
async function fillSelector(selector,value) { await evaluate("(() => {const element=document.querySelector("+JSON.stringify(selector)+");const prototype=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,"+JSON.stringify(value)+");element.dispatchEvent(new Event('input',{bubbles:true}));})()"); }

async function reviewGeometry(note) {
  await evaluate("[...document.querySelector('section[aria-label=\"Automatic geometry proposals\"]').querySelectorAll('input[type=checkbox]')].forEach(input=>{if(!input.checked)input.click()})");
  await fillSelector('section[aria-label="Automatic geometry proposals"] textarea',note);
}
try {
  await navigate('reset'); await navigate('plans'); await evaluate('window.__offlineFixture.setAutomatic()');
  const pdfPath=path.join(output,'offline-automatic-plan.pdf');await fs.writeFile(pdfPath,new Uint8Array(await(await fetch('http://127.0.0.1:4187/offline-fixture/geometry.pdf')).arrayBuffer()));
  await wait("document.body.textContent.includes('No plan uploaded')",'empty upload');await upload('input[type=file][accept=".pdf,application/pdf"]',pdfPath);
  await wait("JSON.parse(localStorage.getItem('roughbid-offline-fixture-project'))?.revisions?.[0]?.processingStatus==='ready'",'PDF verified upload');
  await wait("[...document.querySelectorAll('label')].some(l=>l.textContent.includes('Full Takeoff V2'))",'durable mode');
  await evaluate("[...document.querySelectorAll('label')].find(l=>l.textContent.includes('Full Takeoff V2')).querySelector('input').click()");await click('Start Full Takeoff V2');
  await wait('window.__offlineFixture.fullRun','saved durable job');await evaluate("window.__offlineFixture.advancePlan('needs_review')");await navigate('plans');await click('AI Plan Assistant');
  await wait("document.body.textContent.includes('Full Takeoff V2: needs review')",'saved job result');
  await click('Review geometry on this sheet');await wait("document.body.textContent.includes('Synthetic room floor')",'automatic proposals');
  await assert("window.__offlineFixture.requests.some(r=>r.path.endsWith('/geometry/runs')&&r.query.includes('file_id=offline-pdf')) && document.querySelector('section[aria-label=\"Automatic geometry proposals\"]').textContent.includes('Coverage remains incomplete')",'uploaded PDF durable result loads geometry proposals for its saved file/page without claiming full coverage');
  await click('Review proposal');await wait("document.querySelector('svg[aria-label=\"Provider geometry preview\"]')",'provider geometry preview');
  await assert("document.body.textContent.includes('not aligned to the PDF page') && window.__offlineFixture.geometryCandidates[0].quantity===5.94579456",'provider coordinates remain separately identified and original SI area is preserved');
  await click('Confirm reviewed measurement');await assert("window.__offlineFixture.requests.filter(r=>r.path.endsWith('/offline-auto-geometry/review')).length===0",'automatic measure cannot be confirmed without explicit source review');
  await reviewGeometry('Offline synthetic provider polygon checked against the private source; physical room identity and duplicate views reviewed.');await click('Confirm reviewed measurement');
  await wait("document.body.textContent.includes('Reviewed geometry saved.')",'confirmed automatic measure');
  await assert("(() => {const body=window.__offlineFixture.requests.find(r=>r.path.endsWith('/offline-auto-geometry/review')).body;return body.decision==='accepted'&&!('quantity'in body)&&body.expectedRevision===0&&window.__offlineFixture.geometryCandidates[0].quantity===5.94579456&&window.__offlineFixture.measurements.length===0;})()",'confirmation saves only evidence decision and revision; manual scale/quantity entry is unnecessary');
  await evaluate("document.querySelector('section[aria-label=\"Automatic geometry proposals\"]').scrollIntoView({block:'start'})");await screenshot('20-automatic-geometry-confirmed');
  await evaluate("[...document.querySelector('section[aria-label=\"Automatic geometry proposals\"]').querySelectorAll('strong')].find(item=>item.textContent==='Synthetic object surface needing correction').parentElement.parentElement.querySelector('button').click()");await reviewGeometry('Offline synthetic object polygon is a separate object surface and must not be counted as the room floor. Route correction to source review.');await click('Correct this proposal');
  await wait("document.body.textContent.includes('Proposal rejected.')",'correction routed');
  await assert("window.__offlineFixture.geometryCandidates.find(item=>item.label==='Synthetic object surface needing correction'&&item.measurementKind==='area').status==='rejected'&&window.__offlineFixture.requests.filter(r=>r.path.endsWith('/offline-auto-geometry/review')).length===2&&document.body.textContent.includes('Correct its measurement against the source')",'correction rejects the unsuitable object instead of adding its area to the floor');
  await navigate('plans');await wait("document.querySelector('section[aria-label=\"Construction catalog and evidenced budget\"]')?.textContent.includes('64 SF')",'geometry approved budgeting');
  await assert("window.__offlineFixture.geometryCandidates.filter(item=>item.status==='accepted').length===1 && document.querySelector('section[aria-label=\"Construction catalog and evidenced budget\"]').textContent.includes('64 SF')",'only confirmed geometry reaches the construction budget, converted once from SI to SF');
  await setField('Service with matching units','RB-FLOOR-003',0,'select');await click('Calculate & save budget review');
  await wait("document.body.textContent.includes('Saved construction-budget review')",'geometry budget saved');
  await assert("window.__offlineFixture.snapshots[0].sourceKind==='geometry'&&window.__offlineFixture.snapshots[0].result.totalUsd===null&&window.__offlineFixture.snapshots[0].result.lines[0].quantity===64&&!document.querySelector('section[aria-label=\"Construction catalog and evidenced budget\"]').textContent.includes('$0.00')",'geometry budget snapshot saves 64 SF and keeps absent prices pending, without producing a zero quote');
  await evaluate("[...document.querySelectorAll('h3')].find(h=>h.textContent==='Saved construction-budget review').closest('article').scrollIntoView({block:'start'})");await screenshot('21-automatic-geometry-budget');
  await navigate('viewer');await wait("document.body.textContent.includes('Read-only access. Accepted evidence')",'viewer accepted result');
  await assert("!([...document.querySelectorAll('button')].find(b=>b.textContent.includes('Calculate & save budget review')))",'read-only role can inspect the automatic result without saving a budget');
  if(report.exceptions.length)throw new Error('Uncaught browser exceptions: '+report.exceptions.join('; '));
  if(report.externalRequestsBlocked.length)throw new Error('Unexpected external request attempts.');
  report.passed=true;
} catch(error) {report.passed=false;report.error=error.message;await screenshot('automatic-failure').catch(()=>{});console.error(error.stack);}
finally{report.finishedAt=new Date().toISOString();report.mockRequests.push(...await evaluate('window.__offlineFixture?.requests ?? []').catch(()=>[]));await fs.writeFile(path.join(output,'offline-browser-automatic-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,assertions:report.assertions.length,externalRequestsBlocked:report.externalRequestsBlocked.length,exceptions:report.exceptions.length,screenshots:report.screenshots},null,2));socket.close();}
if(!report.passed)process.exitCode=1;
