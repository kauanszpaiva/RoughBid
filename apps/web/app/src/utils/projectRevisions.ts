import type { PlanRevision, Project } from '../types/index.ts';

export type RevisionPatch = Partial<Omit<PlanRevision, 'id'>>;

/** Applies a completed background job to the latest project, never its old snapshot. */
export function patchProjectRevision(project: Project, revisionId: string, patch: RevisionPatch): Project {
  if (!project.revisions.some((revision) => revision.id === revisionId)) return project;
  return {
    ...project,
    revisions: project.revisions.map((revision) => revision.id === revisionId ? { ...revision, ...patch } : revision),
  };
}
