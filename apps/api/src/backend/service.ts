import { calculateEstimate, createClassPassWindow, isClassPassActive, type EstimateInput, type EstimateResult } from '../../../../packages/domain/src/index.ts';

export type User = { id: string };
export type Project = {
  id: string;
  workspaceId: string;
  createdBy: string;
  name: string;
  status: 'draft' | 'active' | 'archived';
};
export type StoredEstimate = EstimateInput & EstimateResult & {
  id: string;
  projectId: string;
  workspaceId: string;
  createdBy: string;
};

/** A deterministic store used by the service and replaceable by a database adapter. */
export class MemoryBackendStore {
  readonly workspaceMembers = new Map<string, Set<string>>();
  readonly entitlements = new Map<string, ReturnType<typeof createClassPassWindow>>();
  readonly projects = new Map<string, Project>();
  readonly estimates = new Map<string, StoredEstimate>();
  readonly files = new Map<string, { workspaceId: string; projectId: string; private: true; mimeType: 'application/pdf' }>();
}

export class RoughBidService {
  #sequence = 0;
  private readonly store: MemoryBackendStore;

  constructor(store: MemoryBackendStore) {
    this.store = store;
  }

  grantWorkspaceAccess(workspaceId: string, userId: string): void {
    const members = this.store.workspaceMembers.get(workspaceId) ?? new Set<string>();
    members.add(userId);
    this.store.workspaceMembers.set(workspaceId, members);
  }

  grantClassPass(userId: string, startsAt: Date) {
    const pass = createClassPassWindow(startsAt);
    this.store.entitlements.set(userId, pass);
    return pass;
  }

  #authorize(user: User | null, workspaceId: string, at: Date): User {
    if (!user) throw new Error('Authentication required.');
    if (!this.store.workspaceMembers.get(workspaceId)?.has(user.id)) throw new Error('Workspace access denied.');
    const entitlement = this.store.entitlements.get(user.id);
    if (!entitlement || !isClassPassActive(entitlement, at)) throw new Error('Active entitlement required.');
    return user;
  }

  createProject(user: User | null, workspaceId: string, name: string, at = new Date()): Project {
    const actor = this.#authorize(user, workspaceId, at);
    if (!name.trim()) throw new Error('Project name is required.');
    const project = { id: `project-${++this.#sequence}`, workspaceId, createdBy: actor.id, name: name.trim(), status: 'draft' as const };
    this.store.projects.set(project.id, project);
    return { ...project };
  }

  listProjects(user: User | null, workspaceId: string, at = new Date()): Project[] {
    this.#authorize(user, workspaceId, at);
    return [...this.store.projects.values()].filter((project) => project.workspaceId === workspaceId).map((project) => ({ ...project }));
  }

  updateProject(user: User | null, workspaceId: string, projectId: string, changes: Pick<Project, 'name' | 'status'>, at = new Date()): Project {
    this.#authorize(user, workspaceId, at);
    const project = this.#projectInWorkspace(projectId, workspaceId);
    if (!changes.name.trim()) throw new Error('Project name is required.');
    Object.assign(project, { name: changes.name.trim(), status: changes.status });
    return { ...project };
  }

  deleteProject(user: User | null, workspaceId: string, projectId: string, at = new Date()): void {
    this.#authorize(user, workspaceId, at);
    this.#projectInWorkspace(projectId, workspaceId);
    this.store.projects.delete(projectId);
  }

  uploadPlan(user: User | null, workspaceId: string, projectId: string, file: { name: string; mimeType: string; bytes: number }, at = new Date()) {
    this.#authorize(user, workspaceId, at);
    this.#projectInWorkspace(projectId, workspaceId);
    if (file.mimeType !== 'application/pdf' || !file.name.toLowerCase().endsWith('.pdf')) throw new Error('Only PDF plans may be uploaded.');
    if (file.bytes <= 0 || file.bytes > 52_428_800) throw new Error('PDF must be between 1 byte and 50 MB.');
    const path = `${workspaceId}/${projectId}/${++this.#sequence}-${file.name}`;
    const record = { workspaceId, projectId, private: true as const, mimeType: 'application/pdf' as const };
    this.store.files.set(path, record);
    return { path, ...record };
  }

  saveEstimate(user: User | null, workspaceId: string, projectId: string, input: EstimateInput, at = new Date()): StoredEstimate {
    const actor = this.#authorize(user, workspaceId, at);
    this.#projectInWorkspace(projectId, workspaceId);
    const estimate = { id: `estimate-${++this.#sequence}`, workspaceId, projectId, createdBy: actor.id, ...input, ...calculateEstimate(input) };
    this.store.estimates.set(estimate.id, estimate);
    return { ...estimate };
  }

  #projectInWorkspace(projectId: string, workspaceId: string): Project {
    const project = this.store.projects.get(projectId);
    // Do not reveal whether an identifier exists in another tenant.
    if (!project || project.workspaceId !== workspaceId) throw new Error('Project not found.');
    return project;
  }
}
