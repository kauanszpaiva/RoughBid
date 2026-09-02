import test from 'node:test';
import assert from 'node:assert/strict';
import { IntegrationService, type IntegrationAdapter } from '../src/integrations/framework.ts';

test('integration framework connects, isolates tenants, deduplicates exports, and revokes secrets', async () => {
  let exportCalls = 0;
  const adapter: IntegrationAdapter = {
    provider: 'quickbooks',
    getAuthorizationUrl: async (state) => `https://example.test/oauth?state=${state}`,
    exchangeCode: async () => ({ externalTenantId: 'realm-1', credentials: { token: 'secret' } }),
    exportEstimate: async (_credentials, _estimate, key) => { exportCalls++; return { externalId: key }; },
    revoke: async () => {},
  };
  const secrets = new Map<string, unknown>();
  const service = new IntegrationService([adapter], {
    put: async (id, value) => { secrets.set(id, value); }, get: async (id) => secrets.get(id), delete: async (id) => { secrets.delete(id); },
  });
  const authorization = await service.authorizationUrl('quickbooks', 'ws-1', 'https://app.test/callback');
  assert.match(authorization.url, /^https:/);
  await assert.rejects(service.connect('quickbooks', 'ws-2', 'code', authorization.state, 'https://app.test/callback'), /state/i);
  const retry = await service.authorizationUrl('quickbooks', 'ws-1', 'https://app.test/callback');
  const connection = await service.connect('quickbooks', 'ws-1', 'code', retry.state, 'https://app.test/callback');
  assert.equal(service.list('ws-1').length, 1);
  assert.equal(service.list('ws-2').length, 0);
  const first = await service.exportEstimate(connection.id, 'ws-1', 'est-1', { total: 100 });
  assert.deepEqual(await service.exportEstimate(connection.id, 'ws-1', 'est-1', { total: 100 }), first);
  assert.equal(exportCalls, 1);
  await assert.rejects(service.exportEstimate(connection.id, 'ws-2', 'est-1', {}), /not found/i);
  await service.disconnect(connection.id, 'ws-1');
  assert.equal(secrets.size, 0);
});
