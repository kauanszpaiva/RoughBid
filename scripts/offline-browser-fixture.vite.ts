import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { reviewMeasurement } from '../apps/api/src/takeoff-v2/measurement-review';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scripts, '..');
const geometrySource = (async () => {
  const document = await PDFDocument.create();
  document.setCreationDate(new Date('2026-10-02T00:00:00Z')); document.setModificationDate(new Date('2026-10-02T00:00:00Z'));
  const page = document.addPage([100, 100]), font = await document.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({ x: 20, y: 40, width: 40, height: 40, borderWidth: 0.3, borderColor: rgb(0, 0, 0) });
  page.drawText('Synthetic room boundary', { x: 15, y: 91, size: 3, font });
  page.drawText('North half-span: 4 ft', { x: 20, y: 82, size: 2, font });
  page.drawText('West half-span: 4 ft', { x: 2, y: 72, size: 2, font });
  page.drawText('OFFLINE fixture only - no real plan', { x: 10, y: 10, size: 3, font });
  const bytes = await document.save(), sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, context: { runId: 'offline-geometry-run', fileId: 'offline-geometry-pdf', fileSha256: sha256,
    physicalPageCount: 1, sheet: { physicalPageNumber: 1, pageSha256: sha256, pageWidthPoints: 100, pageHeightPoints: 100,
      rotationDegrees: 0, displayWidthPoints: 100, displayHeightPoints: 100 } } };
})();
export default defineConfig({
  root: scripts,
  // Deliberately exclude every repository/local credential file from Vite env loading.
  envDir: path.join(scripts, 'offline-browser-fixture-env'),
  publicDir: path.join(root, 'apps/web/app/public'),
  plugins: [react(), tailwindcss(), {
    name: 'offline-pure-geometry-review',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/offline-fixture/')) { next(); return; }
        void (async () => {
          const source = await geometrySource;
          response.setHeader('Cache-Control', 'no-store');
          if (request.url === '/offline-fixture/geometry.pdf' && request.method === 'GET') { response.setHeader('Content-Type', 'application/pdf'); response.end(source.bytes); return; }
          response.setHeader('Content-Type', 'application/json');
          if (request.url === '/offline-fixture/geometry-context' && request.method === 'GET') { response.end(JSON.stringify(source.context)); return; }
          if (request.url === '/offline-fixture/measurement-review' && request.method === 'POST') {
            let body = ''; for await (const chunk of request) { body += chunk.toString(); if (body.length > 100_000) throw new Error('Offline review fixture body exceeds its bound.'); }
            const result = reviewMeasurement(JSON.parse(body), { runId: source.context.runId, workspaceId: 'offline-workspace', projectId: 'offline-project', fileId: source.context.fileId,
              fileSha256: source.context.fileSha256, physicalPageNumber: 1, pageSha256: source.context.sheet.pageSha256, widthPoints: 100, heightPoints: 100, rotationDegrees: 0 });
            response.end(JSON.stringify(result)); return;
          }
          response.statusCode = 404; response.end(JSON.stringify({ error: 'Unmocked offline fixture path.' }));
        })().catch((error) => { response.statusCode = 422; response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Offline review failed.' })); });
      });
    },
  }],
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('http://127.0.0.1:4187/offline-supabase'),
    'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('offline-fixture-public-placeholder'),
    'import.meta.env.VITE_API_BASE_URL': JSON.stringify(''),
  },
  server: { host: '127.0.0.1', port: 4187, strictPort: true, hmr: false, fs: { allow: [root] } },
});
