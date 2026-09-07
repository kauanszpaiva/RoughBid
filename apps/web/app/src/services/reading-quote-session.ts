import type { ReadingQuote } from './api.ts';

export const PLAN_TRADES = ['Framing', 'Concrete', 'Drywall', 'Electrical', 'Plumbing', 'HVAC', 'Finishes'];
export type ReadingQuoteContext = { workspaceId: string; projectId: string; fileId: string };
export type ReadingQuoteStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type FetchSavedQuote = (workspaceId: string, projectId: string, fileId: string, quoteId: string) => Promise<ReadingQuote>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['quoted', 'paid', 'processing', 'complete', 'failed', 'revoked']);

function storageKey(context: ReadingQuoteContext) {
  return `roughbid:reading-quote:v1:${JSON.stringify([context.workspaceId, context.projectId, context.fileId])}`;
}

/** The browser keeps an opaque reference only. Payment and scope always come from the server. */
export function saveReadingQuoteId(storage: ReadingQuoteStorage, context: ReadingQuoteContext, quoteId: string) {
  if (!UUID.test(quoteId)) throw new Error('The reading reference is invalid. Refresh and try again.');
  storage.setItem(storageKey(context), quoteId);
}

export function clearSavedReadingQuote(storage: ReadingQuoteStorage, context: ReadingQuoteContext) {
  storage.removeItem(storageKey(context));
}

export async function restoreSavedReadingQuote(storage: ReadingQuoteStorage, context: ReadingQuoteContext, fetchQuote: FetchSavedQuote): Promise<ReadingQuote | null> {
  const quoteId = storage.getItem(storageKey(context));
  if (quoteId === null) return null;
  if (!UUID.test(quoteId)) throw new Error('The saved reading reference is invalid. Its payment status could not be verified.');
  const quote = await fetchQuote(context.workspaceId, context.projectId, context.fileId, quoteId);
  if (quote.id !== quoteId || quote.project_id !== context.projectId || quote.file_id !== context.fileId
    || !STATUSES.has(quote.status) || !Array.isArray(quote.trades) || !quote.trades.length
    || quote.trades.some(trade => !PLAN_TRADES.includes(trade)) || !Number.isFinite(Date.parse(quote.expires_at))) {
    throw new Error('The saved reading does not match this plan. Its payment status could not be verified.');
  }
  return quote;
}
