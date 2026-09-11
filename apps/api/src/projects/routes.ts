import { ProjectApiError, ProjectService, type SupabaseLike } from './service.ts';

const json = (body: unknown, status = 200) => Response.json(body, { status });

export async function handleProjectRequest(request: Request, db: SupabaseLike): Promise<Response> {
  try {
    const { data, error } = await db.auth.getUser();
    if (error || !data.user) throw new ProjectApiError(401, 'Authentication required');
    const workspaceId = request.headers.get('x-workspace-id');
    if (!workspaceId) throw new ProjectApiError(400, 'x-workspace-id header is required');
    const service = new ProjectService(db, data.user.id, workspaceId);
    const url = new URL(request.url);
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);

    if (parts[0] === 'projects' && parts.length === 1) {
      if (request.method === 'GET') return json(await service.list());
      if (request.method === 'POST') return json(await service.create(await request.json()), 201);
    }
    if (parts[0] === 'projects' && parts[1] && parts.length === 2) {
      if (request.method === 'GET') return json(await service.get(parts[1]));
      if (request.method === 'PATCH') return json(await service.update(parts[1], await request.json()));
      if (request.method === 'DELETE') return json(await service.remove(parts[1]));
    }
    if (parts[0] === 'projects' && parts[1] && parts[2] === 'estimate-versions' && parts.length === 3 && request.method === 'GET') {
      const revision = url.searchParams.get('revision');
      return json(revision ? await service.getEstimateVersion(parts[1], revision) : await service.listEstimateVersions(parts[1]));
    }
    if (parts[0] === 'projects' && parts[1] && parts[2] === 'files' && request.method === 'POST') {
      const file = (await request.formData()).get('file');
      if (!(file instanceof File)) throw new ProjectApiError(400, 'file is required');
      return json(await service.upload(parts[1], file), 201);
    }
    if (parts[0] === 'project-files' && parts[1] && parts[2] === 'download' && request.method === 'POST') {
      return json(await service.createDownloadUrl(parts[1]));
    }
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    if (error instanceof ProjectApiError) return json({ error: error.message }, error.status);
    return json({ error: 'Internal server error' }, 500);
  }
}
