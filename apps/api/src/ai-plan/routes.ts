import { ProjectApiError, type SupabaseLike } from '../projects/service.ts';
import {
  AiPlanReadingService,
  type AiPlanObjectStorage,
  type PlanReader,
  type PlanReadingFindingStatus,
  type PlanReadingFindingsWriter,
} from './service.ts';

const json = (body: unknown, status = 200) => Response.json(body, { status });

const FINDING_STATUSES: readonly PlanReadingFindingStatus[] = ['needs_review', 'accepted', 'rejected'];

export interface AiPlanRequestDependencies {
  findingsWriter: PlanReadingFindingsWriter;
  storage: AiPlanObjectStorage;
  reader: PlanReader;
}

export async function handleAiPlanRequest(request: Request, db: SupabaseLike, deps: AiPlanRequestDependencies): Promise<Response> {
  try {
    const { data, error } = await db.auth.getUser();
    if (error || !data.user) throw new ProjectApiError(401, 'Authentication required');
    const workspaceId = request.headers.get('x-workspace-id');
    if (!workspaceId) throw new ProjectApiError(400, 'x-workspace-id header is required');

    const service = new AiPlanReadingService(db, deps.findingsWriter, deps.storage, deps.reader, data.user.id, workspaceId);
    const url = new URL(request.url);
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);

    if (request.method === 'POST' && parts[0] === 'projects' && parts[1] && parts[2] === 'ai-plan-readings') {
      // Reads and prices the plan synchronously — see AiPlanReadingService.create().
      return json(await service.create(parts[1], await request.json()), 201);
    }
    if (request.method === 'GET' && parts[0] === 'ai-plan-readings' && parts[1]) {
      return json(await service.get(parts[1]));
    }
    if (request.method === 'PATCH' && parts[0] === 'ai-plan-readings' && parts[1] === 'findings' && parts[2]) {
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      const status = body.status;
      if (typeof status !== 'string' || !FINDING_STATUSES.includes(status as PlanReadingFindingStatus)) {
        throw new ProjectApiError(400, 'status must be needs_review, accepted, or rejected');
      }
      return json(await service.setFindingStatus(parts[2], status as PlanReadingFindingStatus));
    }
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    if (error instanceof ProjectApiError) return json({ error: error.message }, error.status);
    return json({ error: 'Internal server error' }, 500);
  }
}
