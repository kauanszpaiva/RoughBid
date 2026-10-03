import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleApiRequest } from '../src/http/handler.ts';

const project = '20000000-0000-4000-8000-000000000001';
const asset = '30000000-0000-4000-8000-000000000001';
const run = '40000000-0000-4000-8000-000000000001';
const endpoints = [
  ['GET', 'capability', 'capability.ts'],
  ['POST', 'uploads', 'uploads.ts'],
  ['POST', `uploads/${asset}/complete`, 'uploads/[assetId]/complete.ts'],
  ['POST', `uploads/${asset}/download-url`, 'uploads/[assetId]/download-url.ts'],
  ['GET', 'runs', 'runs.ts'],
  ['POST', 'runs', 'runs.ts'],
  ['GET', `runs/${run}`, 'runs/[runId].ts'],
  ['POST', `runs/${run}/cancel`, 'runs/[runId]/cancel.ts'],
  ['POST', `runs/${run}/resume`, 'runs/[runId]/resume.ts'],
  ['POST', `runs/${run}/review`, 'runs/[runId]/review.ts'],
] as const;

test('every private photo endpoint is mounted and closes before storage/provider calls without a server writer', async () => {
  const names = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_PLAN_FUNCTION'] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  let networkCalls = 0;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'local-test-public-key';
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_PLAN_FUNCTION;
  globalThis.fetch = (async () => { networkCalls++; throw new Error('No network calls are authorized in this test.'); }) as typeof fetch;
  try {
    for (const [method, path] of endpoints) {
      const response = await handleApiRequest(new Request(`https://test/api/projects/${project}/photos/${path}`, {
        method, ...(method === 'POST' ? { body: '{}', headers: { 'content-type': 'application/json' } } : {}),
      }));
      assert.equal(response.status, 503, `${method} ${path}`);
      assert.deepEqual(await response.json(), { error: 'Private photo processing is not configured.' });
    }
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('photo endpoints have Vercel bridges that resolve to the shared authenticated API handler', async () => {
  const wrappers = new Set(endpoints.map(endpoint => endpoint[2]));
  for (const relativePath of wrappers) {
    const file = new URL(`../../../api/projects/[id]/photos/${relativePath}`, import.meta.url);
    const source = await readFile(file, 'utf8');
    const match = source.match(/^export \{ config, default \} from '([^']+)';\s*$/);
    assert.ok(match, relativePath);
    const bridge = new URL(match[1]!, file);
    assert.equal(bridge.pathname, new URL('../../../api/_bridge.ts', import.meta.url).pathname);
  }
});
