/** Roles are ordered from most to least privileged. */
export const WORKSPACE_ROLES = ['admin', 'estimator', 'viewer'] as const;

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

export const WORKSPACE_PERMISSIONS = [
  'workspace:manage',
  'member:manage',
  'project:read',
  'project:write',
  'estimate:read',
  'estimate:write',
  'plan-file:read',
  'plan-file:write',
] as const;

export type WorkspacePermission = (typeof WORKSPACE_PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<WorkspaceRole, readonly WorkspacePermission[]> = {
  admin: WORKSPACE_PERMISSIONS,
  estimator: ['project:read', 'project:write', 'estimate:read', 'estimate:write', 'plan-file:read', 'plan-file:write'],
  viewer: ['project:read', 'estimate:read', 'plan-file:read'],
};

export function hasWorkspacePermission(role: WorkspaceRole, permission: WorkspacePermission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function normalizeWorkspaceName(name: string): string {
  const normalized = name.trim();
  if (normalized.length === 0 || normalized.length > 120) {
    throw new RangeError('Workspace name must contain between 1 and 120 characters.');
  }
  return normalized;
}
