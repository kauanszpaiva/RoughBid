import type {
  Project,
  MaterialItem,
  AssemblyItem,
  PriceList,
  UserProfile,
} from "../types";

// Browser caches are isolated by authenticated account and workspace. Legacy
// unscoped keys are deliberately never imported into an authenticated account.

const STORAGE_KEY_PROJECTS = "roughbid_projects_v1";
const STORAGE_KEY_MATERIALS = "roughbid_materials_v1";
const STORAGE_KEY_ASSEMBLIES = "roughbid_assemblies_v1";
const STORAGE_KEY_PRICELISTS = "roughbid_pricelists_v1";
const STORAGE_KEY_USER = "roughbid_user_v1";

export const INITIAL_USER: UserProfile = {
  id: "",
  name: "RoughBid Estimator",
  email: "",
  role: "Estimator",
  plan: "RoughBid SaaS",
  company: "",
  licenseNumber: "",
  defaultOverhead: 12,
  defaultMarkup: 20,
};

export const INITIAL_PROJECTS: Project[] = [];

export const INITIAL_MATERIALS: MaterialItem[] = [];

export const INITIAL_ASSEMBLIES: AssemblyItem[] = [];

export const INITIAL_PRICELISTS: PriceList[] = [];

export type StorageScope = { userId: string; workspaceId: string };

function scopedKey(key: string, scope: StorageScope): string {
  if (!scope.userId || !scope.workspaceId) throw new Error("An authenticated workspace is required.");
  return `${key}:${encodeURIComponent(scope.userId)}:${encodeURIComponent(scope.workspaceId)}`;
}

function readValue<T>(key: string, fallback: T): T {
  try {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) as T : fallback;
  } catch {
    return fallback;
  }
}

function writeValue(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Object URLs belong to one browser session, never to a persisted project. */
export function persistentProject(project: Project): Project {
  return {
    ...project,
    revisions: project.revisions.map(({ fileUrl: _fileUrl, ...revision }) => revision),
  };
}

function readProjects(key: string): Project[] {
  const value = readValue<unknown>(key, []);
  if (!Array.isArray(value)) return [];
  return value.filter((project): project is Project => Boolean(project && typeof project === "object" &&
    typeof project.id === "string" && typeof project.name === "string" &&
    Array.isArray(project.revisions) && Array.isArray(project.quantities) && Array.isArray(project.estimateItems)))
    .map(persistentProject);
}

export const StorageService = {
  getProjects(scope: StorageScope): Project[] {
    return readProjects(scopedKey(STORAGE_KEY_PROJECTS, scope));
  },

  saveProjects(projects: Project[], scope: StorageScope): boolean {
    return writeValue(scopedKey(STORAGE_KEY_PROJECTS, scope), projects.map(persistentProject));
  },

  getPendingProjects(scope: StorageScope): Project[] {
    const legacyKey = scopedKey("roughbid_pending_projects_v1", scope);
    const pending = new Map(readProjects(legacyKey).map((project) => [project.id, project]));
    const prefix = `${scopedKey("roughbid_pending_project_v2", scope)}:`;
    try {
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (!key?.startsWith(prefix)) continue;
        const projectId = decodeURIComponent(key.slice(prefix.length));
        const project = readProjects(key).find((candidate) => candidate.id === projectId);
        // An empty entry explicitly acknowledges this project's legacy draft.
        pending.delete(projectId);
        if (project) pending.set(projectId, project);
      }
    } catch { /* Keep any readable drafts when browser storage is unavailable. */ }
    return [...pending.values()];
  },

  /** Touch only this project; another tab may have unsaved work on others. */
  savePendingProject(projectId: string, project: Project | null, scope: StorageScope): boolean {
    const key = `${scopedKey("roughbid_pending_project_v2", scope)}:${encodeURIComponent(projectId)}`;
    return writeValue(key, project ? [persistentProject(project)] : []);
  },

  /** Adds drafts without clearing pending projects owned by another queue. */
  savePendingProjects(projects: Project[], scope: StorageScope): boolean {
    return projects.map((project) => this.savePendingProject(project.id, project, scope)).every(Boolean);
  },

  getProjectById(id: string, scope: StorageScope): Project | null {
    return this.getProjects(scope).find((project) => project.id === id) ?? null;
  },

  saveProject(project: Project, scope: StorageScope): boolean {
    const projects = this.getProjects(scope);
    const index = projects.findIndex((candidate) => candidate.id === project.id);
    if (index >= 0) projects[index] = project;
    else projects.unshift(project);
    return this.saveProjects(projects, scope);
  },

  deleteProject(id: string, scope: StorageScope): boolean {
    return this.saveProjects(this.getProjects(scope).filter((project) => project.id !== id), scope);
  },

  getMaterials(scope: StorageScope): MaterialItem[] {
    return readValue(scopedKey(STORAGE_KEY_MATERIALS, scope), INITIAL_MATERIALS);
  },

  saveMaterials(materials: MaterialItem[], scope: StorageScope): boolean {
    return writeValue(scopedKey(STORAGE_KEY_MATERIALS, scope), materials);
  },

  getAssemblies(scope: StorageScope): AssemblyItem[] {
    return readValue(scopedKey(STORAGE_KEY_ASSEMBLIES, scope), INITIAL_ASSEMBLIES);
  },

  saveAssemblies(assemblies: AssemblyItem[], scope: StorageScope): boolean {
    return writeValue(scopedKey(STORAGE_KEY_ASSEMBLIES, scope), assemblies);
  },

  getPriceLists(scope: StorageScope): PriceList[] {
    return readValue(scopedKey(STORAGE_KEY_PRICELISTS, scope), INITIAL_PRICELISTS);
  },

  getUser(userId?: string): UserProfile {
    if (!userId) return { ...INITIAL_USER };
    const saved = readValue<Partial<UserProfile> | null>(`${STORAGE_KEY_USER}:${encodeURIComponent(userId)}`, null);
    return { ...INITIAL_USER, ...(saved && typeof saved === "object" ? saved : {}), id: userId };
  },

  getUserProfile(userId?: string): UserProfile {
    return this.getUser(userId);
  },

  saveUser(user: UserProfile): boolean {
    return Boolean(user.id) && writeValue(`${STORAGE_KEY_USER}:${encodeURIComponent(user.id)}`, user);
  },

  saveUserProfile(user: UserProfile): boolean {
    return this.saveUser(user);
  },
};
