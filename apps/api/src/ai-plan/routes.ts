import { ProjectApiError, type SupabaseLike } from '../projects/service.ts';
import { AiPlanReadingService, type AiPlanQueue } from './service.ts';
import type { AiPlanReadingProcessor } from './processor.ts';

const json = (body: unknown, status = 200) => Response.json(body, { status });

export async function handleAiPlanRequest(
  request: Request,
  db: SupabaseLike,
  queue: AiPlanQueue,
  processorFactory?: (workspaceId: string) => AiPlanReadingProcessor,
): Promise<Response> {
  try {
    const { data, error } = await db.auth.getUser();
    if (error || !data.user) throw new ProjectApiError(401, 'Authentication required');
    const workspaceId = request.headers.get('x-workspace-id');
    if (!workspaceId) throw new ProjectApiError(400, 'x-workspace-id header is required');

    const service = new AiPlanReadingService(db, queue, data.user.id, workspaceId);
    const url = new URL(request.url);
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);

    if (request.method === 'POST' && parts[0] === 'projects' && parts[1] && parts[2] === 'ai-plan-readings') {
      if (!process.env.OPENAI_API_KEY) return json({ error: 'AI plan reading is not configured.' }, 503);
      return json(await service.create(parts[1], await request.json()), 202);
    }
    if (request.method === 'GET' && parts[0] === 'ai-plan-readings' && parts[1]) {
      return json(await service.get(parts[1]));
    }
    if (request.method === 'POST' && parts[0] === 'ai-plan-readings' && parts[1] && parts[2] === 'process') {
      if (!processorFactory) return json({ error: 'AI plan reading processor is not configured.' }, 503);
      return json(await processorFactory(workspaceId).process(parts[1]), 202);
    }
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    if (error instanceof ProjectApiError) return json({ error: error.message }, error.status);
    return json({ error: 'Internal server error' }, 500);
  }
}
