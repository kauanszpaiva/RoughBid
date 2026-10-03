import type { FullTakeoffRun } from '../services/api.ts';

/** Saved work is evidence of processing, never certification of the whole plan. */
export function planFileCoverage(run: FullTakeoffRun, expectedPages?: number) {
  const sheets = run.sheets ?? [];
  const total = Number.isSafeInteger(expectedPages) && expectedPages! > 0 ? expectedPages! : null;
  const recorded = new Set(sheets.filter(sheet => sheet.passes.some(pass => ['succeeded', 'blocked'].includes(pass.status))).map(sheet => sheet.physical_page_number)).size;
  const reviewedPages = new Set(sheets.filter(sheet => sheet.status === 'ready' && sheet.passes.length > 0 && sheet.passes.every(pass => pass.status === 'succeeded')).map(sheet => sheet.physical_page_number)).size;
  const pending = Math.max(total ?? sheets.length, sheets.length) - reviewedPages;
  const pageCount = total === null ? 'Page count pending' : `${total} ${total === 1 ? 'page' : 'pages'}`;
  return {
    pageCount,
    saved: `${recorded}${total === null ? '' : `/${total}`} pages with saved results`,
    pending: pending > 0 ? `${pending} ${pending === 1 ? 'page needs' : 'pages need'} attention` : 'Measurements and prices still require review',
  };
}

export function planFileStatus(status: string | undefined): string {
  return ({ queued: 'Waiting to read', processing: 'Reading', waiting_budget: 'Waiting for processing capacity',
    needs_review: 'Results need review', ready: 'Results need review', failed: 'Reading stopped', cancelled: 'Reading canceled',
    quoted: 'Awaiting payment', paid: 'Payment confirmed', revoked: 'Purchase closed', complete: 'Results need review' } as Record<string, string>)[status ?? ''] ?? 'Ready to read';
}
