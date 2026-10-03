/** Checkout return values select saved server state; they never prove payment. */
export function readPhotoPurchaseReturn(search: string) {
  const query = new URLSearchParams(search);
  const payment = query.get('payment');
  if (query.get('reading_mode') !== 'photo_batch' || (payment !== 'returned' && payment !== 'canceled')) return null;
  const workspaceId = query.get('workspace_id'), projectId = query.get('project_id'), quoteId = query.get('photo_quote_id');
  const valid = (value: string | null): value is string => Boolean(value && /^[a-zA-Z0-9_-]{1,128}$/.test(value));
  return valid(workspaceId) && valid(projectId) && valid(quoteId) ? { workspaceId, projectId, quoteId, payment } : null;
}
