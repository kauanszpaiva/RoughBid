import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Isolated synthetic fixture only. No login, customer PDF, Stripe, or AI call.
const playwright = await import(new URL('../.browser-tests/node_modules/playwright/index.mjs', import.meta.url).href);
const repo = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(path.join(repo, '.viewer-check-'));
let server;
try {
  await mkdir(path.join(root, 'public'));
  await mkdir(path.join(repo, 'test-results'), { recursive: true });
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 23; i++) {
    const sheet = pdf.addPage([1440, 1000]);
    sheet.drawText(`SYNTHETIC TEST - Sheet ${i}`, { x: 80, y: 900, size: 32, font });
    sheet.drawRectangle({ x: 100, y: 200, width: 200 + i * 10, height: 300, borderWidth: 4 });
  }
  await writeFile(path.join(root, 'public', 'sample.pdf'), await pdf.save());
  const appHtml = await readFile(path.join(repo, 'dist', 'app', 'index.html'), 'utf8');
  const cssAsset = [...appHtml.matchAll(/href="([^"]+\.css)"/g)].map(match => match[1]).find(asset => /^\/assets\/[a-z0-9._-]+\.css$/i.test(asset));
  assert.ok(cssAsset, 'Use the real production CSS from the preceding app build.');
  await writeFile(path.join(root, 'public', 'production.css'), await readFile(path.join(repo, 'dist', cssAsset.slice(1))));
  await writeFile(path.join(root, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/production.css"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>');
  await writeFile(path.join(root, 'main.tsx'), `
import React, { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { usePdfDocument } from '../apps/web/app/src/features/plans/hooks/usePdfDocument';
import { BlueprintPage } from '../apps/web/app/src/features/plans/viewer/BlueprintPage';
function Fixture() {
  const [url, setUrl] = useState(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(100);
  useEffect(() => {
    if (location.search.includes('broken')) { setUrl('/missing.pdf'); return; }
    let active = true; let objectUrl;
    fetch('/sample.pdf').then(r => r.blob()).then(blob => {
      objectUrl = URL.createObjectURL(blob);
      if (active) setUrl(objectUrl); else URL.revokeObjectURL(objectUrl);
    });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, []);
  const { pdf, status, error } = usePdfDocument(url);
  return <section className="border border-slate-200" aria-label="Synthetic viewer verification PDF preview">
    <div>
      <label>Page <select aria-label="PDF page" value={pageNumber} disabled={!pdf} onChange={event => setPageNumber(Number(event.target.value))}>{Array.from({ length: pdf?.numPages ?? 1 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select></label>
      <button type="button" aria-label="Zoom in" disabled={!pdf} onClick={() => setZoom(value => value + 25)}>Zoom in</button>
    </div>
    {error && <p role="status">{error}</p>}
    {status === 'loading' && <p role="status">Opening blueprint...</p>}
    {pdf && <BlueprintPage pdf={pdf} pageNumber={pageNumber} fileName="synthetic-23-pages.pdf" zoomPercent={zoom} findings={[]} annotations={[]} selectedFindingId={null} selectedAnnotationId={null} showAiMarkers={true} showFindingHighlights={true} showManualNotes={true} />}
  </section>;
}
createRoot(document.getElementById('root')).render(<StrictMode><Fixture /></StrictMode>);
`);
  const vercel = JSON.parse(await readFile(path.join(repo, 'vercel.json'), 'utf8'));
  const csp = vercel.headers?.flatMap(rule => rule.headers ?? []).find(header => header.key.toLowerCase() === 'content-security-policy')?.value;
  assert.ok(csp, 'Exercise the same CSP that protects production.');
  const config = {
    configFile: false, root, base: '/', plugins: [react(), {
      name: 'synthetic-missing-file', configurePreviewServer(instance) {
        instance.middlewares.use((req, res, next) => {
          if (req.url === '/missing.pdf') { res.statusCode = 404; res.end('not found'); } else next();
        });
      },
    }],
    build: { outDir: path.join(root, 'dist'), emptyOutDir: true },
    preview: { host: '127.0.0.1', port: 4179, strictPort: true, headers: { 'Content-Security-Policy': csp } },
  };
  await build(config);
  server = await preview(config);
  for (const browserName of ['chromium', 'webkit']) {
    const browser = await playwright[browserName].launch({ headless: true,
      ...(browserName === 'chromium' && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    });
    try {
      const context = await browser.newContext(browserName === 'webkit'
        ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
        : { viewport: { width: 1365, height: 900 } });
      const external = [];
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname === '127.0.0.1' || ['blob:', 'data:', 'about:'].includes(url.protocol)) return route.continue();
        external.push(url.origin); return route.abort();
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto('http://127.0.0.1:4179/');
      const canvas = page.locator('canvas[aria-label^="Uploaded PDF:"]');
      await canvas.waitFor({ state: 'visible', timeout: 30_000 });
      const styled = await page.getByRole('region', { name: 'Synthetic viewer verification PDF preview' }).evaluate(element => parseFloat(getComputedStyle(element).borderTopWidth) > 0);
      assert.equal(styled, true, 'The production stylesheet must be loaded, not an unstyled harness.');
      assert.equal(await page.locator('[aria-label="PDF page"] option').count(), 23);
      assert.equal(await canvas.evaluate(c => c.width > 0 && c.height > 0), true);
      const firstPage = await canvas.evaluate(c => c.toDataURL());
      await page.getByLabel('PDF page', { exact: true }).selectOption('23');
      await page.waitForFunction(old => {
        const c = document.querySelector('canvas[aria-label^="Uploaded PDF:"]');
        return c && c.offsetParent !== null && c.toDataURL() !== old;
      }, firstPage, { timeout: 20_000 });
      assert.equal(await canvas.getAttribute('aria-label'), 'Uploaded PDF: synthetic-23-pages.pdf, page 23');
      const width = await canvas.evaluate(c => c.width);
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
      await page.waitForFunction(oldWidth => document.querySelector('canvas[aria-label^="Uploaded PDF:"]')?.width > oldWidth, width);
      await page.screenshot({ path: path.join(repo, 'test-results', `blueprint-${browserName}.png`), fullPage: true });
      await page.goto('http://127.0.0.1:4179/?broken=1');
      await page.getByRole('status').filter({ hasText: 'Unable to open this PDF (404)' }).waitFor({ state: 'visible' });
      assert.equal(await canvas.isVisible(), false);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      console.log(`PASS ${browserName}: extracted PDF primitives render real worker output, navigate 23 pages, zoom, and expose explicit 404 under production CSP`);
    } finally { await browser.close(); }
  }
} finally {
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  const cleanupRoot = path.resolve(root);
  if (!cleanupRoot.startsWith(path.resolve(repo) + path.sep) || !path.basename(cleanupRoot).startsWith('.viewer-check-')) throw new Error('Refusing cleanup outside the isolated viewer fixture.');
  await rm(cleanupRoot, { recursive: true, force: true });
}
