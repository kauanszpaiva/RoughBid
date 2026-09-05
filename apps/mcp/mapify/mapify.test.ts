import test from 'node:test';
import assert from 'node:assert/strict';
import { MapifyClient } from './client.ts';
import { handleMapifyMessage } from './tools.ts';

test('Mapify client authenticates measurement requests and encodes resource IDs', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new MapifyClient({ apiKey: 'private-key', baseUrl: 'https://mapify.test/', fetcher: async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json({ jobId: 'job-1', status: 'processing' });
  }});
  await client.requestMeasurements({ address: '10 Main St', externalProjectId: 'project-1' });
  await client.getBlueprint('building/1', 'dxf');
  assert.equal(requests[0]?.url, 'https://mapify.test/v1/buildings/measurements');
  assert.equal((requests[0]?.init?.headers as Record<string, string>).authorization, 'Bearer private-key');
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), { address: '10 Main St', externalProjectId: 'project-1' });
  assert.equal(requests[1]?.url, 'https://mapify.test/v1/buildings/building%2F1/blueprint?format=dxf');
});

test('MCP tools list capabilities, validate input, and return structured results', async () => {
  const client = new MapifyClient({ apiKey: 'key', baseUrl: 'http://localhost:8787', fetcher: async () => Response.json({ area: { value: 2400, unit: 'sq_ft' } }) });
  const listed = await handleMapifyMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, client);
  assert.equal((listed?.result as { tools: unknown[] }).tools.length, 3);
  const result = await handleMapifyMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mapify_measure_building', arguments: { address: '10 Main St' } } }, client);
  assert.deepEqual((result?.result as { structuredContent: unknown }).structuredContent, { area: { value: 2400, unit: 'sq_ft' } });
  const invalid = await handleMapifyMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mapify_get_job', arguments: {} } }, client);
  assert.equal((invalid?.result as { isError: boolean }).isError, true);
});

test('Mapify client rejects insecure remote endpoints and sanitizes non-JSON errors', async () => {
  assert.throws(() => new MapifyClient({ apiKey: 'key', baseUrl: 'http://mapify.test' }), /HTTPS/);
  const client = new MapifyClient({ apiKey: 'key', baseUrl: 'https://mapify.test', fetcher: async () => new Response('gateway failure', { status: 502 }) });
  await assert.rejects(client.getJob('job-1'), /Mapify request failed \(502\)$/);
});
