import {
  validateEmail,
  normalizeInviteRole,
  normalizeWorkspaceName,
  type AddWorkspaceMemberInput,
  type CreateWorkspaceInput,
  type CreateWorkspaceInviteInput,
  type UpdateWorkspaceInput,
  type UpdateWorkspaceMemberInput,
  type Workspace,
  type WorkspaceInvite,
  type WorkspaceMembership,
  type WorkspaceRole,
} from '../../../../packages/domain/src/index.ts';
import { createHash, randomBytes } from 'node:crypto';
import { requireUser, throwIfError, type AuthenticatedSupabaseClient } from '../supabase/client.ts';

const workspace = (row: Record<string, unknown>): Workspace => ({
  id: String(row.id), name: String(row.name), createdBy: String(row.created_by), createdAt: String(row.created_at),
  aiProcessingConsentedAt: row.ai_processing_consented_at == null ? null : String(row.ai_processing_consented_at),
});
const membership = (row: Record<string, unknown>): WorkspaceMembership => ({
  workspaceId: String(row.workspace_id), userId: String(row.user_id),
  role: String(row.role) as WorkspaceRole, createdAt: String(row.created_at),
});
const invite = (row: Record<string, unknown>): WorkspaceInvite => ({
  id: String(row.id), workspaceId: String(row.workspace_id), email: String(row.email),
  role: String(row.role) as WorkspaceRole, expiresAt: String(row.expires_at),
  acceptedAt: row.accepted_at === null ? null : String(row.accepted_at), createdAt: String(row.created_at),
});
const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

function appInviteUrl(appUrl: string, token: string): string {
  const url = new URL(appUrl);
  const basePath = url.pathname.replace(/\/$/, '');
  url.pathname = `${basePath}/app/`.replace(/\/{2,}/g, '/');
  url.search = '';
  url.hash = '';
  url.searchParams.set('invite', token);
  return url.toString();
}

export type WorkspaceWithRole = Workspace & { role: WorkspaceRole | null };

const knownRole = (value: unknown): WorkspaceRole | null =>
  value === 'admin' || value === 'estimator' || value === 'viewer' ? value : null;

export async function listWorkspaces(client: AuthenticatedSupabaseClient): Promise<WorkspaceWithRole[]> {
  const user = await requireUser(client);
  const [workspaces, memberships] = await Promise.all([
    client.from('workspaces').select('*').order('created_at'),
    client.from('workspace_members').select('workspace_id, role').eq('user_id', user.id),
  ]);
  throwIfError(workspaces.error);
  throwIfError(memberships.error);
  const memberRows = Array.isArray(memberships.data) ? memberships.data as Record<string, unknown>[] : [];
  return (workspaces.data as Record<string, unknown>[]).map((row) => ({
    ...workspace(row),
    role: knownRole(memberRows.find((member) => member.workspace_id === row.id)?.role),
  }));
}

export async function getWorkspace(client: AuthenticatedSupabaseClient, id: string): Promise<Workspace | null> {
  await requireUser(client);
  const { data, error } = await client.from('workspaces').select('*').eq('id', id).single();
  throwIfError(error);
  return data ? workspace(data) : null;
}

export async function createWorkspace(client: AuthenticatedSupabaseClient, input: CreateWorkspaceInput): Promise<WorkspaceWithRole> {
  const user = await requireUser(client);
  const { data, error } = await client.from('workspaces')
    .insert({ name: normalizeWorkspaceName(input.name), created_by: user.id }).select('*').single();
  throwIfError(error);
  if (!data) throw new Error('Workspace insert returned no row.');
  const ownMembership = await client.from('workspace_members').select('role').eq('workspace_id', String(data.id)).eq('user_id', user.id);
  throwIfError(ownMembership.error);
  const rows = Array.isArray(ownMembership.data) ? ownMembership.data as Record<string, unknown>[] : [];
  return { ...workspace(data), role: knownRole(rows[0]?.role) };
}

export async function updateWorkspace(client: AuthenticatedSupabaseClient, id: string, input: UpdateWorkspaceInput): Promise<Workspace | null> {
  await requireUser(client);
  const { data, error } = await client.from('workspaces')
    .update({ name: normalizeWorkspaceName(input.name) }).eq('id', id).select('*').single();
  throwIfError(error);
  return data ? workspace(data) : null;
}

/**
 * Records that the workspace owner has explicitly accepted sending plan
 * files to AI for reading (see docs/architecture/ai-plan-reading-pipeline.md
 * "Security Rules"). Relies on the existing workspaces_update_owner RLS
 * policy — only the workspace's creator can call this successfully.
 */
export async function grantAiProcessingConsent(client: AuthenticatedSupabaseClient, id: string): Promise<Workspace | null> {
  await requireUser(client);
  const { data, error } = await client.from('workspaces')
    .update({ ai_processing_consented_at: new Date().toISOString() }).eq('id', id).select('*').single();
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

export async function createWorkspaceInvite(client: AuthenticatedSupabaseClient, workspaceId: string, input: CreateWorkspaceInviteInput): Promise<WorkspaceInvite & { token: string }> {
  const user = await requireUser(client);
  const email = validateEmail(input.email);
  const role = normalizeInviteRole(input.role);
  const token = randomBytes(32).toString('base64url');
  const token_hash = hashToken(token);
  const expires_at = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await client.from('workspace_invites')
    .insert({ workspace_id: workspaceId, email, role, token_hash, expires_at, created_by: user.id })
    .select('id, workspace_id, email, role, expires_at, accepted_at, created_at')
    .single();
  throwIfError(error);
  if (!data) throw new Error('Invite insert returned no row.');
  return { ...invite(data), token };
}

export async function createWorkspaceInviteWithEmail(
  client: AuthenticatedSupabaseClient,
  workspaceId: string,
  input: CreateWorkspaceInviteInput & { appUrl?: string },
  sendInviteEmail?: (input: { to: string; workspaceName: string; inviteUrl: string; role: 'estimator' | 'viewer'; inviteId: string }) => Promise<unknown>,
): Promise<WorkspaceInvite & { token: string; emailSent: boolean; emailError?: string }> {
  const created = await createWorkspaceInvite(client, workspaceId, input);
  let emailSent = false;
  let emailError: string | undefined;
  if (sendInviteEmail && input.appUrl) {
    const workspaceRecord = await getWorkspace(client, workspaceId);
    if (!workspaceRecord) throw new Error('Workspace not found.');
    try {
      await sendInviteEmail({
        to: created.email,
        workspaceName: workspaceRecord.name,
        inviteUrl: appInviteUrl(input.appUrl, created.token),
        role: created.role === 'admin' ? 'estimator' : created.role,
        inviteId: created.id,
      });
      emailSent = true;
    } catch (error) {
      emailError = error instanceof Error ? error.message : 'Invite email could not be sent.';
    }
  }
  return { ...created, emailSent, ...(emailError ? { emailError } : {}) };
}

export async function acceptWorkspaceInvite(client: AuthenticatedSupabaseClient, token: string): Promise<{ workspaceId: string; role: WorkspaceRole }> {
  await requireUser(client);
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new TypeError('Invalid invite token.');
  if (!client.rpc) throw new Error('Supabase RPC support is required.');
  const { data, error } = await client.rpc('accept_workspace_invite', { invite_token_digest: hashToken(token) });
  throwIfError(error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') throw new Error('Invite acceptance returned no row.');
  const record = row as Record<string, unknown>;
  return { workspaceId: String(record.workspace_id), role: String(record.role) as WorkspaceRole };
}
