import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const playwright = await import(new URL('../.browser-tests/node_modules/playwright/index.mjs', import.meta.url).href);
const repo = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(path.join(repo, '.plans-workspace-check-'));
let server;
try {
  await mkdir(path.join(root, 'public'));
  await mkdir(path.join(repo, 'test-results'), { recursive: true });
  const syntheticPdf = await PDFDocument.create();
  const font = await syntheticPdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 23; i++) {
    const page = syntheticPdf.addPage([1440, 1000]);
    page.drawText(`SYNTHETIC PLANS WORKSPACE - Sheet ${i}`, { x: 80, y: 900, size: 32, font });
    page.drawRectangle({ x: 120, y: 180, width: 300 + i * 8, height: 340, borderWidth: 4 });
  }
  await writeFile(path.join(root, 'public', 'sample.pdf'), await syntheticPdf.save());
  const appHtml = await readFile(path.join(repo, 'dist', 'app', 'index.html'), 'utf8');
  const cssAsset = [...appHtml.matchAll(/href="([^"]+\.css)"/g)].map(match => match[1]).find(asset => /^\/assets\/[a-z0-9._-]+\.css$/i.test(asset));
  assert.ok(cssAsset, 'The production app build must exist before workspace browser verification.');
  await writeFile(path.join(root, 'public', 'production.css'), await readFile(path.join(repo, 'dist', cssAsset.slice(1))));
  await writeFile(path.join(root, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/production.css"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>');
  await writeFile(path.join(root, 'main.tsx'), `
import React, { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PlansWorkspace } from '../apps/web/app/src/features/plans/PlansWorkspace';

const revision = { id: 'fixture', revisionNumber: '01', fileName: 'synthetic-23-pages.pdf', fileSize: '1.0 MB', pages: 23, uploadDate: 'Sep 11, 2026', uploadedBy: 'Estimator', isCurrent: true, notes: '', annotations: [] };
const findings = [
  {id:'mapped-box',page_number:3,finding_type:'material',label:'Exterior wall',value_text:null,quantity:40,unit:'LF',confidence:.95,geometry:{bbox:[.2,.2,.2,.2]},source_excerpt:'Exterior bearing wall',status:'needs_review'},
  {id:'mapped-point',page_number:5,finding_type:'risk',label:'Header check',value_text:null,quantity:null,unit:null,confidence:.72,geometry:{point:[.6,.4]},source_excerpt:'Verify header',status:'needs_review'},
  {id:'unmapped',page_number:7,finding_type:'scope_note',label:'General note',value_text:'Review',quantity:null,unit:null,confidence:.8,geometry:{},source_excerpt:'General note',status:'needs_review'},
];

function Fixture() {
  const [url, setUrl] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  useEffect(() => {
    if (location.search.includes('broken')) { setUrl('/missing.pdf'); return; }
    let active = true; let objectUrl;
    fetch('/sample.pdf').then(response => response.blob()).then(blob => {
      objectUrl = URL.createObjectURL(blob);
      if (active) setUrl(objectUrl); else URL.revokeObjectURL(objectUrl);
    });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, []);
  const currentRevision = { ...revision, annotations };
  return <div style={{height:'900px'}}><PlansWorkspace
    projectName="Synthetic"
    currentRevision={currentRevision}
    previewUrl={url}
    isPreviewLoading={!url}
    previewError={null}
    findings={findings}
    canWrite={true}
    onAnnotationsChange={setAnnotations}
    planInfo={{ currentRevision, revisions:[currentRevision], canWrite:true }}
    pageReview={null}
  /></div>;
}
createRoot(document.getElementById('root')).render(<StrictMode><Fixture /></StrictMode>);
`);
  const vercel = JSON.parse(await readFile(path.join(repo, 'vercel.json'), 'utf8'));
  const csp = vercel.headers?.flatMap(rule => rule.headers ?? []).find(header => header.key.toLowerCase() === 'content-security-policy')?.value;
  assert.ok(csp);
  const config = {
    configFile: false,
    root,
    base: '/',
    plugins: [react(), { name: 'synthetic-missing-file', configurePreviewServer(instance) { instance.middlewares.use((req, res, next) => { if (req.url === '/missing.pdf') { res.statusCode = 404; res.end('not found'); } else next(); }); } }],
    build: { outDir: path.join(root, 'dist'), emptyOutDir: true },
    preview: { host: '127.0.0.1', port: 4187, strictPort: true, headers: { 'Content-Security-Policy': csp } },
  };
  await build(config);
  server = await preview(config);
  const browser = await playwright.chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const external = [];
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname === '127.0.0.1' || ['blob:', 'data:', 'about:'].includes(url.protocol)) return route.continue();
      external.push(url.origin); return route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4187/');
    const workspace = page.getByRole('region', { name: 'Synthetic Plans workspace' });
    await workspace.waitFor({ state: 'visible', timeout: 30_000 });
    const activeCanvas = () => page.locator('canvas[aria-label^="Uploaded PDF:"]:visible').first();
    await activeCanvas().waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await page.getByRole('navigation', { name: 'Plan sheets' }).count(), 1);
    assert.equal(await page.getByRole('complementary', { name: 'Plan inspector' }).count(), 1);
    assert.equal(await page.getByRole('button', { name: /^Open PDF page / }).count(), 23);

    await page.getByRole('button', { name: 'Open PDF page 23', exact: true }).click();
    await page.getByLabel('Uploaded PDF: synthetic-23-pages.pdf, page 23').waitFor({ state: 'visible', timeout: 20_000 });

    await page.getByRole('button', { name: 'Open finding Exterior wall', exact: true }).click();
    await page.getByLabel('Uploaded PDF: synthetic-23-pages.pdf, page 3').waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByRole('button', { name: 'AI finding area: Exterior wall', exact: true }).waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('button', { name: 'AI finding area: Exterior wall', exact: true }).getAttribute('aria-pressed'), 'true');

    await page.getByRole('button', { name: 'Open finding General note', exact: true }).click();
    await page.getByLabel('Uploaded PDF: synthetic-23-pages.pdf, page 7').waitFor({ state: 'visible', timeout: 20_000 });
    assert.equal(await page.getByRole('button', { name: 'AI marker: General note', exact: true }).count(), 0, 'unmapped findings never receive a fabricated marker');

    await page.getByLabel('View mode', { exact: true }).selectOption('continuous');
    await page.waitForTimeout(800);
    const fullResolutionCanvases = page.locator('canvas[aria-label^="Uploaded PDF:"]');
    assert.ok(await fullResolutionCanvases.count() <= 5, 'continuous mode keeps at most five full-resolution page canvases mounted');
    await page.getByLabel('View mode', { exact: true }).selectOption('single');
    await page.getByLabel('Uploaded PDF: synthetic-23-pages.pdf, page 7').waitFor({ state: 'visible', timeout: 20_000 });

    await page.getByRole('button', { name: 'Focus mode', exact: true }).click();
    assert.equal(await page.getByRole('navigation', { name: 'Plan sheets' }).isVisible(), false);
    assert.equal(await page.getByRole('complementary', { name: 'Plan inspector' }).isVisible(), false);
    await page.keyboard.press('Escape');
    await page.getByRole('navigation', { name: 'Plan sheets' }).waitFor({ state: 'visible' });
    await page.getByRole('complementary', { name: 'Plan inspector' }).waitFor({ state: 'visible' });

    await page.screenshot({ path: path.join(repo, 'test-results', 'plans-workspace-chromium.png'), fullPage: true });
    await page.goto('http://127.0.0.1:4187/?broken=1');
    await page.getByRole('status').filter({ hasText: 'Unable to open this PDF (404)' }).waitFor({ state: 'visible', timeout: 20_000 });
    assert.equal(await page.locator('canvas[aria-label^="Uploaded PDF:"]:visible').count(), 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log('PASS: full Plans workspace uses sheets, grounded findings, bounded continuous rendering, focus mode, and explicit preview failure.');
  } finally {
    await browser.close();
  }
} finally {
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  const cleanupRoot = path.resolve(root);
  if (!cleanupRoot.startsWith(path.resolve(repo) + path.sep) || !path.basename(cleanupRoot).startsWith('.plans-workspace-check-')) throw new Error('Refusing cleanup outside the isolated plans workspace fixture.');
  await rm(cleanupRoot, { recursive: true, force: true });
}
