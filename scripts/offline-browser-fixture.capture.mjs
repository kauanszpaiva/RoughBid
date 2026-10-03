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
  await navigate('geometry');
  await wait("document.body.textContent.includes('64 SF') && document.body.textContent.includes('Source fingerprint and page dimensions verified')", 'saved geometry visual proof');
  await click('View / review evidence'); await setField('Zoom', '0.5', 0, 'select');
  await wait("document.querySelector('svg[aria-label=\"Drawing measurement overlay\"]') && document.body.textContent.includes('64 SF')", 'saved trace restored');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:2000,deviceScaleFactor:1,mobile:false});
  await evaluate('window.scrollTo(0,0)'); await sleep(300);
  const metrics=await send('Page.getLayoutMetrics');
  const file=path.join(output,'12-plan-reviewed-overlay.png');
  const screenshotData=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:1440,height:Math.ceil(metrics.cssContentSize.height),scale:1}});
  await fs.writeFile(file,Buffer.from(screenshotData.data,'base64'));report.screenshots.push(file);
  report.passed=true;report.note='Presentation capture only; 13 geometry and 8 budget assertions remain in their separate reports. Source and saved measurement are synthetic/local.';
} catch(error) {report.passed=false;report.error=error.message;console.error(error.stack);}
finally{report.finishedAt=new Date().toISOString();report.mockRequests.push(...await evaluate('window.__offlineFixture?.requests ?? []').catch(()=>[]));await fs.writeFile(path.join(output,'offline-browser-capture-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,externalRequestsBlocked:report.externalRequestsBlocked.length,exceptions:report.exceptions.length,screenshots:report.screenshots},null,2));socket.close();}
if(!report.passed)process.exitCode=1;
