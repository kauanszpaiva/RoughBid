import { ProjectApiError, type SupabaseLike } from '../projects/service.ts';

const json = (body: unknown, status = 200) => Response.json(body, { status });

type PricingContextRow = {
  project_id: string;
  workspace_id: string;
  project_address_text: string | null;
  plan_address: Record<string, unknown> | null;
  pricing_address: Record<string, unknown> | null;
  address_source: 'plan' | 'project' | 'confirmed_override' | null;
  address_status: 'missing' | 'clear' | 'needs_resolution' | 'resolved';
  plan_file_id?: string | null;
  plan_job_id?: string | null;
  resolved_by?: string | null;
  resolved_at?: string | null;
};

function dbResult<T>(result: { data: T; error: { message?: string } | null }, notFound = false): T {
  if (result.error) throw new ProjectApiError(500, result.error.message ?? 'Database operation failed');
  if (notFound && !result.data) throw new ProjectApiError(404, 'Pricing context not found');
  return result.data;
}

async function readContext(db: SupabaseLike, workspaceId: string, projectId: string): Promise<PricingContextRow> {
  return dbResult<PricingContextRow>(
    await db.from('project_pricing_contexts').select('*')
      .eq('workspace_id', workspaceId).eq('project_id', projectId).maybeSingle(),
    true,
  );
}

function parseChoiceBody(body: unknown): 'plan' | 'project' {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ProjectApiError(400, 'Request body must contain only choice.');
  }
  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length !== 1 || entries[0]?.[0] !== 'choice' || (entries[0]?.[1] !== 'plan' && entries[0]?.[1] !== 'project')) {
    throw new ProjectApiError(400, 'Request body must contain only choice: plan or project.');
  }
  return entries[0][1];
}

/** Workspace-scoped read and narrow human resolution boundary for pricing address trust state. */
export async function handlePricingContextRequest(request: Request, db: SupabaseLike): Promise<Response> {
  try {
    const { data, error } = await db.auth.getUser();
    if (error || !data.user) throw new ProjectApiError(401, 'Authentication required');
    const workspaceId = request.headers.get('x-workspace-id');
    if (!workspaceId) throw new ProjectApiError(400, 'x-workspace-id header is required');

    const parts = new URL(request.url).pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const projectId = parts[0] === 'projects' ? parts[1] : undefined;
    const isContext = parts[2] === 'pricing-context';
    const isAddressResolution = parts.length === 4 && parts[3] === 'address';
    if (!projectId || !isContext) throw new ProjectApiError(404, 'Not found');

    if (request.method === 'GET' && parts.length === 3) {
      return json(await readContext(db, workspaceId, projectId));
    }

    if (request.method === 'PATCH' && isAddressResolution) {
      const choice = parseChoiceBody(await request.json().catch(() => null));
      const context = await readContext(db, workspaceId, projectId);

      const membership = dbResult<any>(
        await db.from('workspace_members').select('role')
          .eq('workspace_id', workspaceId).eq('user_id', data.user.id).maybeSingle(),
      );
      if (!membership || (membership.role !== 'admin' && membership.role !== 'estimator')) {
        throw new ProjectApiError(403, 'Admin or estimator access is required to resolve a pricing address.');
      }
      if (choice === 'plan' && !context.plan_address) {
        throw new ProjectApiError(409, 'No evidenced plan address is available.');
      }
      if (choice === 'project' && (!context.project_address_text || !context.project_address_text.trim())) {
        throw new ProjectApiError(409, 'No project address is available.');
      }
      if (!db.rpc) throw new ProjectApiError(503, 'Pricing address resolution is unavailable.');
      const resolved = await db.rpc('resolve_project_pricing_address', { p_project_id: projectId, p_choice: choice });
      if (resolved.error) {
        const message = resolved.error.message ?? 'Could not resolve pricing address.';
        throw new ProjectApiError(/authoriz/i.test(message) ? 403 : 409, message);
      }

      // Never trust a client payload or the RPC return as the representation to
      // send back. Re-read under the request-scoped RLS client and workspace.
      return json(await readContext(db, workspaceId, projectId));
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    if (error instanceof ProjectApiError) return json({ error: error.message }, error.status);
    return json({ error: 'Internal server error' }, 500);
  }
}
