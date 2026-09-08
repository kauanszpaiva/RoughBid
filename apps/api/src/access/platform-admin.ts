import { ProjectApiError } from '../projects/service.ts';

export interface PlatformAdminDatabase {
  from(table: string): any;
}

/**
 * Resolves the authenticated user's platform-admin flag from the database.
 * This is a commercial-entitlement check only. It never grants workspace,
 * project, file, or tenant access by itself.
 */
export async function isPlatformAdmin(db: PlatformAdminDatabase, userId: string): Promise<boolean> {
  if (!userId) return false;
  const { data, error } = await db.from('profiles')
    .select('is_platform_admin')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw new ProjectApiError(503, 'Unable to verify platform owner access.');
  return data?.is_platform_admin === true;
}

/**
 * Read-only commercial-entitlement check for the Plans UI. The platform-admin
 * flag never overrides workspace tenancy: the caller must still be an
 * admin/estimator in the workspace and the project must belong to it.
 *
 * AI-processing consent is intentionally NOT part of this read-only answer.
 * The complimentary action must remain visible before consent so the UI can
 * guide the user through the explicit consent step instead of falling into a
 * paid-checkout deadlock. The POST plan-reading service independently requires
 * ai_processing_consented_at before any reservation, file download, or provider
 * invocation.
 */
export async function hasPlatformAdminProjectAccess(
  db: PlatformAdminDatabase,
  userId: string,
  workspaceId: string,
  projectId: string,
): Promise<boolean> {
  if (!(await isPlatformAdmin(db, userId))) return false;

  const member = await db.from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (member.error) throw new ProjectApiError(503, 'Unable to verify workspace access.');
  if (!member.data || !['admin', 'estimator'].includes(member.data.role)) return false;

  const project = await db.from('projects')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('id', projectId)
    .maybeSingle();
  if (project.error) throw new ProjectApiError(503, 'Unable to verify project access.');
  return Boolean(project.data);
}
