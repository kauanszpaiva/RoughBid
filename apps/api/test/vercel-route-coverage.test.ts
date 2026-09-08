import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Vercel publishes one serverless function per file under api/. There is no
 * catchall and vercel.json has no /api rewrite, so a path the router handles
 * but that has no file is a 404 in production even though every unit and route
 * test passes. The entitlement endpoint shipped exactly that way once.
 */
const bridge = "export { config, default } from '../../_bridge.ts';\n";
const projectRoutes = ['ai-plan-readings', 'ai-plan-entitlement', 'reading-quote', 'reading-checkout', 'files', 'client-proposals'];

test('every /api/projects/:id route the handler serves has a deployable function file', () => {
  const handler = readFileSync(new URL('../src/http/handler.ts', import.meta.url), 'utf8');
  for (const route of projectRoutes) {
    const file = new URL(`../../../api/projects/[id]/${route}.ts`, import.meta.url);
    assert.ok(existsSync(file), `api/projects/[id]/${route}.ts is missing — the route would 404 on Vercel`);
    assert.equal(readFileSync(file, 'utf8'), bridge, `${route}.ts must re-export the shared bridge`);
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
