import { IntegrationService, type IntegrationProvider } from './framework.ts';

const providers = new Set<IntegrationProvider>(['quickbooks', 'xero', 'procore']);
const json = (body: unknown, status = 200) => Response.json(body, { status });

export type IntegrationRouteDependencies = {
  service: IntegrationService;
  authenticate(request: Request): Promise<{ userId: string; workspaceId: string } | null>;
  loadFinalEstimate(estimateId: string, workspaceId: string): Promise<unknown | null>;
};

/** REST surface shared by all provider adapters; credentials never cross this boundary. */
export async function handleIntegrationRequest(request: Request, dependencies: IntegrationRouteDependencies): Promise<Response> {
  try {
    const actor = await dependencies.authenticate(request);
    if (!actor) return json({ error: 'Authentication required' }, 401);
    const parts = new URL(request.url).pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    if (parts[0] !== 'integrations') return json({ error: 'Not found' }, 404);

    if (parts.length === 1 && request.method === 'GET') return json(dependencies.service.list(actor.workspaceId));
    if (parts[1] === 'authorize' && request.method === 'POST') {
      const body = await request.json() as { provider?: string; redirectUri?: string };
      if (!body.provider || !providers.has(body.provider as IntegrationProvider) || !body.redirectUri) return json({ error: 'Valid provider and redirectUri are required' }, 400);
      return json(await dependencies.service.authorizationUrl(body.provider as IntegrationProvider, actor.workspaceId, body.redirectUri));
    }
    if (parts[1] === 'callback' && request.method === 'POST') {
      const body = await request.json() as { provider?: string; code?: string; state?: string; redirectUri?: string };
      if (!body.provider || !providers.has(body.provider as IntegrationProvider) || !body.code || !body.state || !body.redirectUri) return json({ error: 'Valid provider, code, state, and redirectUri are required' }, 400);
      return json(await dependencies.service.connect(body.provider as IntegrationProvider, actor.workspaceId, body.code, body.state, body.redirectUri), 201);
    }
    if (parts[1] && parts[2] === 'exports' && request.method === 'POST') {
      const body = await request.json() as { estimateId?: string };
      if (!body.estimateId) return json({ error: 'estimateId is required' }, 400);
      const estimate = await dependencies.loadFinalEstimate(body.estimateId, actor.workspaceId);
      if (!estimate) return json({ error: 'Final estimate not found' }, 404);
      return json(await dependencies.service.exportEstimate(parts[1], actor.workspaceId, body.estimateId, estimate), 202);
    }
    if (parts[1] && request.method === 'DELETE') {
      await dependencies.service.disconnect(parts[1], actor.workspaceId);
      return new Response(null, { status: 204 });
    }
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Integration request failed' }, 400);
  }
}
