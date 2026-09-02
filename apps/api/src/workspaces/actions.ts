import {
  normalizeWorkspaceName,
  type AddWorkspaceMemberInput,
  type CreateWorkspaceInput,
  type UpdateWorkspaceInput,
  type UpdateWorkspaceMemberInput,
  type Workspace,
  type WorkspaceMembership,
  type WorkspaceRole,
} from '../../../../packages/domain/src/index.ts';
import { requireUser, throwIfError, type AuthenticatedSupabaseClient } from '../supabase/client.ts';

const workspace = (row: Record<string, unknown>): Workspace => ({
  id: String(row.id), name: String(row.name), createdBy: String(row.created_by), createdAt: String(row.created_at),
});
const membership = (row: Record<string, unknown>): WorkspaceMembership => ({
  workspaceId: String(row.workspace_id), userId: String(row.user_id),
  role: String(row.role) as WorkspaceRole, createdAt: String(row.created_at),
});

export async function listWorkspaces(client: AuthenticatedSupabaseClient): Promise<Workspace[]> {
  await requireUser(client);
  const { data, error } = await client.from('workspaces').select('*').order('created_at');
  throwIfError(error);
  return (data as Record<string, unknown>[]).map(workspace);
}

export async function getWorkspace(client: AuthenticatedSupabaseClient, id: string): Promise<Workspace | null> {
  await requireUser(client);
  const { data, error } = await client.from('workspaces').select('*').eq('id', id).single();
  throwIfError(error);
  return data ? workspace(data) : null;
}

export async function createWorkspace(client: AuthenticatedSupabaseClient, input: CreateWorkspaceInput): Promise<Workspace> {
  const user = await requireUser(client);
  const { data, error } = await client.from('workspaces')
    .insert({ name: normalizeWorkspaceName(input.name), created_by: user.id }).select('*').single();
  throwIfError(error);
  if (!data) throw new Error('Workspace insert returned no row.');
  return workspace(data);
}

export async function updateWorkspace(client: AuthenticatedSupabaseClient, id: string, input: UpdateWorkspaceInput): Promise<Workspace | null> {
  await requireUser(client);
  const { data, error } = await client.from('workspaces')
    .update({ name: normalizeWorkspaceName(input.name) }).eq('id', id).select('*').single();
  throwIfError(error);
  return data ? workspace(data) : null;
}

export async function deleteWorkspace(client: AuthenticatedSupabaseClient, id: string): Promise<void> {
  await requireUser(client);
  const { error } = await client.from('workspaces').delete().eq('id', id);
  throwIfError(error);
}

export async function listWorkspaceMembers(client: AuthenticatedSupabaseClient, workspaceId: string): Promise<WorkspaceMembership[]> {
  await requireUser(client);
  const { data, error } = await client.from('workspace_members').select('*').eq('workspace_id', workspaceId).order('created_at');
  throwIfError(error);
  return (data as Record<string, unknown>[]).map(membership);
}

export async function addWorkspaceMember(client: AuthenticatedSupabaseClient, workspaceId: string, input: AddWorkspaceMemberInput): Promise<WorkspaceMembership> {
  await requireUser(client);
  const { data, error } = await client.from('workspace_members')
    .insert({ workspace_id: workspaceId, user_id: input.userId, role: input.role ?? 'viewer' }).select('*').single();
  throwIfError(error);
  if (!data) throw new Error('Membership insert returned no row.');
  return membership(data);
}

export async function updateWorkspaceMember(client: AuthenticatedSupabaseClient, workspaceId: string, userId: string, input: UpdateWorkspaceMemberInput): Promise<WorkspaceMembership | null> {
  await requireUser(client);
  const { data, error } = await client.from('workspace_members').update({ role: input.role })
    .eq('workspace_id', workspaceId).eq('user_id', userId).select('*').single();
  throwIfError(error);
  return data ? membership(data) : null;
}

export async function removeWorkspaceMember(client: AuthenticatedSupabaseClient, workspaceId: string, userId: string): Promise<void> {
  await requireUser(client);
  const { error } = await client.from('workspace_members').delete().eq('workspace_id', workspaceId).eq('user_id', userId);
  throwIfError(error);
}
