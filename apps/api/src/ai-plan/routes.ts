import { getPageReadingInventory } from './page-inventory.ts';
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
import { FULL_TAKEOFF_V2_MODE, type FullTakeoffV2ProviderFactory } from '../takeoff-v2/service.ts';
import { DurableFullTakeoffV2Service, type FullTakeoffV2Queue } from '../takeoff-v2/durable.ts';
import type { AutomaticGeometryCoordinator } from '../takeoff-v2/automatic-geometry.ts';
import { fullTakeoffApprovalProfile, type FullTakeoffApprovalProfile } from '../takeoff-v2/user-spend-approval.ts';

const json = (body: unknown, status = 200) => Response.json(body, { status });

const FINDING_STATUSES: readonly PlanReadingFindingStatus[] = ['needs_review', 'accepted', 'rejected'];
const CORRECTABLE_FINDING_FIELDS = new Set(['finding_type', 'label', 'value_text', 'quantity', 'unit', 'geometry']);
const CORRECTABLE_FINDING_TYPES = new Set(['measurement', 'symbol', 'room', 'scope_note', 'risk', 'question', 'material', 'labor']);

function correctedFindingTarget(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectApiError(400, 'correction must be a non-empty object');
  }
  const correction = value as Record<string, unknown>;
  const keys = Object.keys(correction);
  if (keys.length === 0) throw new ProjectApiError(400, 'correction must be a non-empty object');
  for (const key of keys) {
    if (!CORRECTABLE_FINDING_FIELDS.has(key)) throw new ProjectApiError(400, `correction field ${key} is not supported`);
  }
  if ('finding_type' in correction && (typeof correction.finding_type !== 'string' || !CORRECTABLE_FINDING_TYPES.has(correction.finding_type))) {
    throw new ProjectApiError(400, 'correction.finding_type is invalid');
  }
  if ('label' in correction && (typeof correction.label !== 'string' || !correction.label.trim() || correction.label.trim().length > 160)) {
    throw new ProjectApiError(400, 'correction.label must be a non-empty string up to 160 characters');
  }
  if ('value_text' in correction && correction.value_text !== null && typeof correction.value_text !== 'string') {
    throw new ProjectApiError(400, 'correction.value_text must be a string or null');
  }
  if ('quantity' in correction && correction.quantity !== null && (
    typeof correction.quantity !== 'number' || !Number.isFinite(correction.quantity) || correction.quantity < 0
  )) {
    throw new ProjectApiError(400, 'correction.quantity must be a non-negative number or null');
  }
  if ('unit' in correction && correction.unit !== null && (
    typeof correction.unit !== 'string' || correction.unit.length > 40
  )) {
    throw new ProjectApiError(400, 'correction.unit must be a string up to 40 characters or null');
  }
  if ('geometry' in correction && (!correction.geometry || typeof correction.geometry !== 'object' || Array.isArray(correction.geometry))) {
    throw new ProjectApiError(400, 'correction.geometry must be an object');
  }
  return correction;
}

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
  /** Production always resolves cohort membership before selecting any reader. */
  pilotEnforcement?: boolean;
  pilotReader?: PlanReader;
  /**
   * Enabled only when a configured provider consumes rendered page images.
   * The page-by-page owner path is the main beneficiary: it reviews one
   * physical page at a time, so a plan set that exceeds the pilot's 10 MB PDF
   * ceiling can still be read page by page.
   */
  pageImagesEnabled?: boolean | undefined;
  /** Durable BullMQ queue. Required only when AI_PLAN_DURABLE_ENABLED=true. */
  durableQueue?: DurableAiPlanQueue | undefined;
  /** Legacy/internal dependency only. HTTP Full V2 never constructs a provider. */
  fullTakeoffV2ProviderFactory?: FullTakeoffV2ProviderFactory | undefined;
  /** Full V2 always runs on a dedicated background worker, never on HTTP. */
  fullTakeoffV2Queue?: FullTakeoffV2Queue | undefined;
  automaticGeometry?:AutomaticGeometryCoordinator | undefined;
}

export async function handleAiPlanRequest(request: Request, db: SupabaseLike, deps: AiPlanRequestDependencies): Promise<Response> {
  try {
    const { data, error } = await db.auth.getUser();
    if (error || !data.user) throw new ProjectApiError(401, 'Authentication required');
    const workspaceId = request.headers.get('x-workspace-id');
    if (!workspaceId) throw new ProjectApiError(400, 'x-workspace-id header is required');

    const service = new AiPlanReadingService(db, deps.findingsWriter, deps.storage, deps.reader, data.user.id, workspaceId, undefined, deps.freeReader, false, undefined, deps.pageImagesEnabled === true);
    const url = new URL(request.url);
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const durableEnabled = process.env.AI_PLAN_DURABLE_ENABLED === 'true';

    if (parts[0] === 'takeoff-runs' && parts[1]) {
      if (!await isPlatformAdmin(db, data.user.id)) throw new ProjectApiError(403, 'Full Takeoff V2 is not enabled for this account.');
      const full = new DurableFullTakeoffV2Service(db, deps.findingsWriter, deps.storage,
        deps.fullTakeoffV2Queue, data.user.id, workspaceId,fetch,deps.automaticGeometry);
      if (request.method === 'GET' && parts.length === 2) {
        if (url.searchParams.has('page_number') || url.searchParams.has('pass_type')) {
          return json(await full.checkpoint(parts[1], Number(url.searchParams.get('page_number')), url.searchParams.get('pass_type') ?? '',url.searchParams.get('region_key')??undefined));
        }
        return json(await full.get(parts[1]));
      }
      if (request.method === 'POST' && parts[2] === 'cancel') return json(await full.cancel(parts[1]));
      if (request.method === 'POST' && parts[2] === 'restart') {
        if (process.env.TAKEOFF_V2_ENABLED !== 'true') throw new ProjectApiError(503, 'Full Takeoff V2 is disabled.');
        return json(await full.restart(parts[1]), 202);
      }
    }

    if (request.method === 'GET' && parts[0] === 'projects' && parts[1] && parts[2] === 'ai-plan-readings') {
      return json(await getPageReadingInventory(db, deps.storage, data.user.id, workspaceId, parts[1],
        url.searchParams.get('file_id') ?? '', { scope: url.searchParams.get('scope') ?? '', trades: url.searchParams.getAll('trade') }));
    }
    if (request.method === 'POST' && parts[0] === 'projects' && parts[1] && parts[2] === 'ai-plan-readings') {
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(body, 'page_number') && body.mode !== FULL_TAKEOFF_V2_MODE) {
        if (!await hasPlatformAdminProjectAccess(db, data.user.id, workspaceId, parts[1])) throw new ProjectApiError(403, 'Page-by-page review is not enabled for this account.');
        if (deps.paidReaderAvailable !== true) throw new ProjectApiError(503, 'The page-reading provider is unavailable. No job was started.');
        const owner = new AiPlanReadingService(db, deps.findingsWriter, deps.storage, deps.reader, data.user.id, workspaceId, undefined, undefined, true, undefined, deps.pageImagesEnabled === true);
        return json(await owner.create(parts[1], body), 201);
      }
      if (body.mode === FULL_TAKEOFF_V2_MODE) {
        // A deep run can outlive Vercel's request limit. This boundary only
        // reserves/enqueues; no HTTP path may initialize or call its provider.
        if (!await isPlatformAdmin(db, data.user.id)) {
          throw new ProjectApiError(403, 'Full Takeoff V2 is not enabled for this account.');
        }
        if (process.env.TAKEOFF_V2_ENABLED !== 'true') throw new ProjectApiError(503, 'Full Takeoff V2 is disabled. No run was started.');
        const full = new DurableFullTakeoffV2Service(db, deps.findingsWriter, deps.storage,
          deps.fullTakeoffV2Queue, data.user.id, workspaceId,fetch,deps.automaticGeometry);
        return json(await full.reserve(parts[1], body), 202);
      }
      // The outer production handler always supplies paidReaderAvailable. Tests
      // and internal callers that omit it preserve the legacy service contract.
      // Platform-owner identity is verified exactly once here and then injected
      // into the service; the service never trusts browser-provided metadata.
      if (deps.paidReaderAvailable !== undefined) {
        const platformAdmin = await isPlatformAdmin(db, data.user.id);
        if (platformAdmin) {
          if (!deps.paidReaderAvailable) throw new ProjectApiError(503, 'The paid plan-reading provider is not configured. No job was started.');
          if (durableEnabled) {
            if (!deps.durableQueue) throw new ProjectApiError(503, 'Durable AI plan queue is not configured. No job was queued.');
            const durable = new DurableAiPlanReadingService(
              db, deps.findingsWriter, deps.storage, deps.durableQueue, data.user.id, workspaceId,
            );
            return json(await durable.reservePlatformAdmin(parts[1], body), 202);
          }
          const adminService = new AiPlanReadingService(
            db, deps.findingsWriter, deps.storage, deps.reader,
            data.user.id, workspaceId, undefined, deps.freeReader, true, undefined, deps.pageImagesEnabled === true,
          );
          return json(await adminService.create(parts[1], body), 201);
        }
      }
      if (deps.pilotEnforcement) {
        if (!deps.findingsWriter.rpc) throw new ProjectApiError(503, 'Pilot access verification is unavailable.');
        const access = await deps.findingsWriter.rpc('get_pilot_access', { p_user_id: data.user.id });
        if (access.error) throw new ProjectApiError(503, 'Pilot access verification is unavailable.');
        if (access.data?.active) {
          if (!deps.pilotReader) throw new ProjectApiError(503, 'Pilot AI is not configured. Your invitation remains active.');
          const pilotService = new AiPlanReadingService(db, deps.findingsWriter, deps.storage, deps.reader,
            data.user.id, workspaceId, undefined, undefined, false, deps.pilotReader);
          return json(await pilotService.create(parts[1], body), 201);
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
        return json(await durable.reserve(parts[1], body), 202);
      }
      // Legacy synchronous path remains available only while the durable flag is off.
      return json(await service.create(parts[1], body), 201);
    }
    if (request.method === 'GET' && parts[0] === 'projects' && parts[1] && parts[2] === 'ai-plan-entitlement') {
      const fullEnabled = process.env.TAKEOFF_V2_ENABLED === 'true';
      if (fullEnabled && await hasPlatformAdminProjectAccess(db, data.user.id, workspaceId, parts[1])) {
        let fullTakeoffV2Available = false;
        let fullTakeoffApproval: FullTakeoffApprovalProfile | undefined;
        if (process.env.REDIS_URL && deps.findingsWriter.rpc) {
          try {
            const live = await deps.findingsWriter.rpc('full_takeoff_v2_worker_available', { p_version: 'takeoff-v2.2-durable' });
            if (!live.error && live.data === true) {
              fullTakeoffApproval = fullTakeoffApprovalProfile(process.env);
              fullTakeoffV2Available = true;
            }
          } catch { /* Capability remains false until a verified worker heartbeat succeeds. */ }
        }
        return json({ freeReadingAvailable: deps.paidReaderAvailable === true, fullTakeoffV2Available, fullTakeoffApproval });
      }
      // Platform-admin complimentary access deliberately uses the paid provider,
      // but still requires the caller to be an admin/estimator in this workspace,
      // the project to belong to it, and AI consent to already exist. Only the
      // production wiring that explicitly confirms a paid reader triggers this
      // lookup, so legacy/free-provider callers remain independent.
      if (deps.paidReaderAvailable === true && await hasPlatformAdminProjectAccess(db, data.user.id, workspaceId, parts[1])) {
        return json({ freeReadingAvailable: true });
      }

      if (deps.pilotEnforcement && deps.findingsWriter.rpc) {
        const access = await deps.findingsWriter.rpc('get_pilot_access', { p_user_id: data.user.id });
        if (access.error) throw new ProjectApiError(503, 'Pilot access verification is unavailable.');
        if (access.data?.active) {
          const project = await db.from('projects').select('id, created_by').eq('workspace_id', workspaceId).eq('id', parts[1]).maybeSingle();
          if (project.error || !project.data) throw new ProjectApiError(404, 'Project not found');
          const eligible = access.data.workspace_id === workspaceId && project.data.created_by === data.user.id;
          return json({ freeReadingAvailable: Boolean(deps.pilotReader) && eligible, pilotActive: true, pilot: access.data });
        }
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
      if (status === 'corrected') {
        if (!db.rpc) throw new ProjectApiError(500, 'Supabase RPC support is required.');
        const correction = correctedFindingTarget(body.correction);
        // Use the request-scoped authenticated client, not the service-role
        // findings writer. The database review RPC depends on auth.uid() and
        // workspace-role checks to preserve the tenant boundary.
        const { data: reviewed, error: reviewError } = await db.rpc('review_plan_reading_finding', {
          p_finding_id: parts[2],
          p_action: 'corrected',
          p_correction: correction,
        });
        if (reviewError) {
          const code = reviewError.code;
          const responseStatus = code === '22023' ? 400 : code === 'P0002' ? 404 : code === '42501' ? 403 : 500;
          throw new ProjectApiError(responseStatus, reviewError.message ?? 'Could not record the corrected finding.');
        }
        const review = Array.isArray(reviewed) ? reviewed[0] : reviewed;
        if (!review || typeof review !== 'object' || (review as { workspace_id?: string }).workspace_id !== workspaceId) {
          throw new ProjectApiError(404, 'Finding review not found');
        }
        return json({ review });
      }
      if (typeof status !== 'string' || !FINDING_STATUSES.includes(status as PlanReadingFindingStatus)) {
        throw new ProjectApiError(400, 'status must be needs_review, accepted, rejected, or corrected');
      }
      if (Object.prototype.hasOwnProperty.call(body, 'correction')) {
        throw new ProjectApiError(400, 'correction is supported only when status is corrected');
      }
      return json(await service.setFindingStatus(parts[2], status as PlanReadingFindingStatus));
    }
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    if (error instanceof ProjectApiError) return json({ error: error.message }, error.status);
    return json({ error: 'Internal server error' }, 500);
  }
}
