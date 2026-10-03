import type { Project } from '../types/index.ts';
import type { ProjectSaveQueue } from './projectSaveQueue.ts';

export type FullPurchaseReturn = {
  workspaceId: string; projectId: string; fileId: string; quoteId: string;
  payment: 'returned' | 'canceled';
};

export function readReadingOrderReturn(search: string) {
  const query = new URLSearchParams(search), payment = query.get('payment');
  if (query.get('reading_mode') !== 'full_order' || (payment !== 'returned' && payment !== 'canceled')) return null;
  const values = ['workspace_id', 'project_id', 'order_id'].map(key => query.get(key));
  if (values.some(value => !value || !/^[A-Za-z0-9_-]{1,160}$/.test(value))) return null;
  return { workspaceId: values[0]!, projectId: values[1]!, orderId: values[2]!, payment: payment as 'returned' | 'canceled' };
}

/** Navigation hints only. Payment and access always come from authenticated APIs. */
export function readFullPurchaseReturn(search: string): FullPurchaseReturn | null {
  const query = new URLSearchParams(search);
  const payment = query.get('payment');
  if (query.get('reading_mode') !== 'full_v2' || (payment !== 'returned' && payment !== 'canceled')) return null;
  const values = ['workspace_id', 'project_id', 'file_id', 'quote_id'].map(key => query.get(key));
  if (values.some(value => !value || !/^[A-Za-z0-9_-]{1,160}$/.test(value))) return null;
  return { workspaceId: values[0]!, projectId: values[1]!, fileId: values[2]!, quoteId: values[3]!, payment };
}

/** Restore only a revision already present in the authenticated workspace response. */
export function restoreFullPurchaseRevision(project: Project, target: FullPurchaseReturn): Project | null {
  if (project.remoteId !== target.projectId || !project.revisions.some(revision => revision.remoteFileId === target.fileId)) return null;
  return { ...project, revisions: project.revisions.map(revision => ({ ...revision, isCurrent: revision.remoteFileId === target.fileId })) };
}

/** Finish the existing project save before an external Checkout can hide an unsaved revision. */
export async function persistFullPurchaseRevision(input: {
  projectId: string; fileId: string;
  queue: Pick<ProjectSaveQueue<Project>, 'retry' | 'wait'>;
  getProject: () => Project | undefined;
  isActive: () => boolean;
}): Promise<void> {
  const assertCurrent = () => {
    const project = input.getProject();
    const revision = project?.revisions.find(item => item.isCurrent) ?? project?.revisions.at(-1);
    if (!input.isActive() || project?.id !== input.projectId || revision?.remoteFileId !== input.fileId) {
      throw new Error('The workspace or selected PDF changed. Review its purchase before opening checkout.');
    }
  };
  assertCurrent();
  input.queue.retry(input.projectId);
  try { await input.queue.wait(input.projectId); }
  catch { throw new Error('Your PDF revision could not be saved. Retry checkout to save it before opening Stripe.'); }
  assertCurrent();
}

/** Persist every selected source before leaving the app for a single Checkout. */
export async function persistReadingOrderFiles(input: {
  projectId: string; fileIds: string[]; queue: Pick<ProjectSaveQueue<Project>, 'retry' | 'wait'>;
  getProject: () => Project | undefined; isActive: () => boolean;
}): Promise<void> {
  const assertCurrent = () => {
    const project = input.getProject();
    if (!input.isActive() || project?.id !== input.projectId || !input.fileIds.length || input.fileIds.length > 20
      || new Set(input.fileIds).size !== input.fileIds.length || input.fileIds.some(id => !project.revisions.some(revision => revision.remoteFileId === id))) {
      throw new Error('The selected files changed. Review the purchase before opening checkout.');
    }
  };
  assertCurrent(); input.queue.retry(input.projectId);
  try { await input.queue.wait(input.projectId); }
  catch { throw new Error('Your selected PDFs could not be saved. Retry checkout to save them before opening Stripe.'); }
  assertCurrent();
}
