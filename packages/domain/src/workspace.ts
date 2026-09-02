export const WORKSPACE_ROLES = ['owner', 'member'] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export type Workspace = {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
};

export type WorkspaceMembership = {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: string;
};

export type CreateWorkspaceInput = { name: string };
export type UpdateWorkspaceInput = { name: string };
export type AddWorkspaceMemberInput = { userId: string; role?: WorkspaceRole };
export type UpdateWorkspaceMemberInput = { role: WorkspaceRole };

export function normalizeWorkspaceName(name: string): string {
  const normalized = name.trim();
  if (normalized.length === 0 || normalized.length > 120) {
    throw new RangeError('Workspace name must contain between 1 and 120 characters.');
  }
  return normalized;
}

