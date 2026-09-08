import { ProjectApiError, type SupabaseLike } from '../projects/service.ts';
import {
  AiPlanReadingService,
  type AiPlanObjectStorage,
  type PlanReader,
  type PlanReadingFindingStatus,
  type PlanReadingFindingsWriter,
} from './service.ts';
import { DurableAiPlanReadingService, type DurableAiPlanQueue } from './durable.ts';
import { isFreeOwnerWorkspace } from './owner-free.ts';
import { isFreeProviderConfigured } from './free-provider.ts';
import { hasPlatformAdminProjectAccess, isPlatformAdmin } from '../access/platform-admin.ts';

const json = (body: unknown, status = 200) => Response.json(body, { status });

const FINDING_STATUSES: readonly PlanReadingFindingStatus[] = ['needs_review', 'accepted', 'rejected'];

export interface AiPlanRequestDependencies {
  findingsWriter: PlanReadingFindingsWriter;
  storage: AiPlanObjectStorage;
  reader: PlanReader;
  /**
   * Reader built from the isolated free-tier credentials. Kept separate from
   * `reader` so an owner-free reading can never be served by the billed
   * provider, and a paid reading can never be served by the free one.
   */
  freeReader?: PlanReader | undefined;
  /** Whether the paid provider is actually configured on this server. */
  paidReaderAvailable?: boolean | undefined;
  /** Durable BullMQ queue. Required only when AI_PLAN_DURABLE_ENABLED=true. */
  durableQueue?: DurableAiPlanQueue | undefined;
}

export async function handleAiPlanRequest(request: Request, db: SupabaseLike, deps: AiPlanRequestDependencies): Promise<Response> {
  try {
    const { data, error } = await db.auth.getUser();
    if (error || !data.user) throw new ProjectApiError(401, 'Authentication required');
    const workspaceId = request.headers.get('x-workspace-id');
    if (!workspaceId) throw new ProjectApiError(400, 'x-workspace-id header is required');

    const service = new AiPlanReadingService(db, deps.findingsWriter, deps.storage, deps.reader, data.user.id, workspaceId, undefined, deps.freeReader);
    const url = new URL(request.url);
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const durableEnabled = process.env.AI_PLAN_DURABLE_ENABLED === 'true';

    if (request.method === 'POST' && parts[0] === 'projects' && parts[1] && parts[2] === 'ai-plan-readings') {
      // The outer production handler always supplies paidReaderAvailable. Tests
      // and internal callers that omit it preserve the legacy service contract.
      // Platform-owner identity is verified exactly once here and then injected
      // into the service; the service never trusts browser-provided metadata.
      if (deps.paidReaderAvailable !== undefined) {
        const platformAdmin = await isPlatformAdmin(db, data.user.id);
        if (platformAdmin) {
          if (!deps.paidReaderAvailable) throw new ProjectApiError(503, 'The paid plan-reading provider is not configured. No job was started.');
          // Platform owner testing remains synchronous even if durable mode is
          // enabled later. The durable paid queue currently requires a paid quote;
          // forcing an admin through it would either charge the owner or weaken the
          // queue's payment invariant.
          const adminService = new AiPlanReadingService(
            db, deps.findingsWriter, deps.storage, deps.reader,
            data.user.id, workspaceId, undefined, deps.freeReader, true,
          );
          return json(await adminService.create(parts[1], await request.json()), 201);
        }
      }
      if (durableEnabled) {
        if (!deps.durableQueue) throw new ProjectApiError(503, 'Durable AI plan queue is not configured. No job was queued.');
        const freeOwner = isFreeOwnerWorkspace(workspaceId, process.env);
        if (freeOwner && !deps.freeReader) throw new ProjectApiError(503, 'The isolated free provider is not configured. No job was queued.');
        if (!freeOwner && deps.paidReaderAvailable === false) throw new ProjectApiError(503, 'The paid plan-reading provider is not configured. No job was queued.');
        const durable = new DurableAiPlanReadingService(
          db, deps.findingsWriter, deps.storage, deps.durableQueue, data.user.id, workspaceId,
        );
        return json(await durable.reserve(parts[1], await request.json()), 202);
      }
      // Legacy synchronous path remains available only while the durable flag is off.
      return json(await service.create(parts[1], await request.json()), 201);
    }
    if (request.method === 'GET' && parts[0] === 'projects' && parts[1] && parts[2] === 'ai-plan-entitlement') {
      // Platform-admin complimentary access deliberately uses the paid provider,
      // but still requires the caller to be an admin/estimator in this workspace,
      // the project to belong to it, and AI consent to already exist. Only the
      // production wiring that explicitly confirms a paid reader triggers this
      // lookup, so legacy/free-provider callers remain independent.
      if (deps.paidReaderAvailable === true && await hasPlatformAdminProjectAccess(db, data.user.id, workspaceId, parts[1])) {
        return json({ freeReadingAvailable: true });
      }

      // Per-caller, database-backed answer for the isolated owner-free provider.
      let configured = isFreeOwnerWorkspace(workspaceId, process.env)
        && isFreeProviderConfigured(process.env)
        && Boolean(deps.freeReader);
      let entitled = false;
      if (configured && deps.findingsWriter.rpc) {
        if (durableEnabled) {
          const worker = await deps.findingsWriter.rpc('ai_plan_worker_available', { p_entitlement: 'owner_free' });
          configured = !worker.error && worker.data === true;
        }
        if (configured) {
          const answer = await deps.findingsWriter.rpc('owner_free_reading_available', {
            p_user_id: data.user.id, p_workspace_id: workspaceId, p_project_id: parts[1],
          });
          entitled = answer.error ? false : answer.data === true;
        }
      }
      return json({ freeReadingAvailable: entitled });
    }
    if (request.method === 'GET' && parts[0] === 'ai-plan-readings' && parts[1]) {
      return json(await service.get(parts[1]));
    }
    if (request.method === 'DELETE' && parts[0] === 'ai-plan-readings' && parts[1]) {
      if (!durableEnabled || !deps.findingsWriter.rpc) throw new ProjectApiError(409, 'Durable cancellation is not enabled.');
      const canceled = await deps.findingsWriter.rpc('request_ai_plan_cancel', {
        p_job_id: parts[1], p_user_id: data.user.id, p_workspace_id: workspaceId,
      });
      if (canceled.error) throw new ProjectApiError(403, canceled.error.message ?? 'Could not cancel the AI plan reading.');
      return json(canceled.data);
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
