import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { matchesGlob } from 'node:path';

/**
 * Vercel publishes one serverless function per file under api/. There is no
 * catchall and vercel.json has no /api rewrite, so a path the router handles
 * but that has no file is a 404 in production even though every unit and route
 * test passes. The entitlement endpoint shipped exactly that way once.
 */
const bridge = "export { config, default } from '../../_bridge.ts';\n";
const projectRoutes = ['ai-plan-readings', 'ai-plan-entitlement', 'reading-quote', 'reading-checkout', 'reading-order', 'reading-order-checkout', 'files', 'client-proposals', 'estimate-versions', 'construction-budget', 'supplier-quotes'];

test('every /api/projects/:id route the handler serves has a deployable function file', () => {
  const handler = readFileSync(new URL('../src/http/handler.ts', import.meta.url), 'utf8');
  for (const route of projectRoutes) {
    const file = new URL(`../../../api/projects/[id]/${route}.ts`, import.meta.url);
    assert.ok(existsSync(file), `api/projects/[id]/${route}.ts is missing — the route would 404 on Vercel`);
    assert.equal(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), bridge, `${route}.ts must re-export the shared bridge`);
  }
  // Guard the pairing: the handler must actually dispatch what we deploy.
  assert.match(handler, /ai-plan-entitlement/, 'outer handler must dispatch the entitlement route');
  assert.match(handler, /ai-plan-readings/, 'outer handler must dispatch the readings route');
});

test('vercel.json still has no /api catchall, so per-route files remain required', () => {
  const vercel = JSON.parse(readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8'));
  const rewrites: Array<{ source: string }> = vercel.rewrites ?? [];
  assert.ok(
    !rewrites.some(r => r.source.startsWith('/api')),
    'an /api rewrite would change this contract — revisit the per-route file requirement above',
  );
});

test('workspace estimating catalog has a deployable function file', () => {
  const handler = readFileSync(new URL('../src/http/handler.ts', import.meta.url), 'utf8');
  const file = new URL('../../../api/workspaces/[id]/estimating-catalog.ts', import.meta.url);
  assert.ok(existsSync(file), 'the estimating catalog route would 404 on Vercel');
  assert.equal(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), bridge);
  assert.match(handler, /estimating-catalog/);
});

test('photo/measurement routes and researched catalog have deployable source coverage',()=>{
  for(const route of ['projects/[id]/photos/uploads','projects/[id]/photos/capability','projects/[id]/photos/quote','projects/[id]/photos/checkout','projects/[id]/photos/runs','projects/[id]/photos/runs/[runId]',
    'projects/[id]/photos/runs/[runId]/cancel','projects/[id]/photos/runs/[runId]/resume','projects/[id]/photos/runs/[runId]/review','takeoff-runs/[id]/measurements',
    'projects/[id]/geometry/capability','projects/[id]/geometry/runs','projects/[id]/geometry/runs/[runId]',
    'projects/[id]/geometry/runs/[runId]/cancel','projects/[id]/geometry/runs/[runId]/resume','projects/[id]/geometry/runs/[runId]/review']){
    assert.ok(existsSync(new URL(`../../../api/${route}.ts`,import.meta.url)),`Missing deployable route: ${route}`);
  }
  const vercel=JSON.parse(readFileSync(new URL('../../../vercel.json',import.meta.url),'utf8'));
  assert.ok(matchesGlob('packages/domain/data/estimating-catalog.v1.json', vercel.functions['api/**/*.ts'].includeFiles),'The API calculation must include its versioned JSON catalog.');
});

test('durable provider bridge deploys with explicit PDF rendering resources',()=>{
  assert.ok(existsSync(new URL('../../../api/internal/provider-bridge/v1.ts',import.meta.url)));
  const vercel=JSON.parse(readFileSync(new URL('../../../vercel.json',import.meta.url),'utf8'));
  const pattern = vercel.functions['api/**/*.ts'].includeFiles;
  assert.ok(pattern.length <= 256, 'Vercel includeFiles schema limit');
  for(const resource of ['standard_fonts','cmaps','wasm']) {
    const files = readdirSync(new URL(`../../../node_modules/pdfjs-dist/${resource}/`, import.meta.url));
    assert.ok(files.length > 0);
    for(const file of files) assert.ok(matchesGlob(`node_modules/pdfjs-dist/${resource}/${file}`, pattern), `Missing renderer resource: ${resource}/${file}`);
  }
  assert.ok(matchesGlob('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', pattern));
  assert.ok(matchesGlob('node_modules/@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node', pattern));
});
