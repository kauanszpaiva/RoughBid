import React, { useEffect, useRef, useState } from 'react';
import { bootstrapAuth, getPageReviewInventory, startPhysicalPageReading, type PageReviewInventory, type PlanReadingJobStatus } from '../services/api';

const TRADES = ['Framing','Concrete','Drywall','Electrical','Plumbing','HVAC','Finishes'];
type Props = {
  workspaceId: string; projectId: string; fileId: string; scope: string; canWrite: boolean;
  onBusyChange: (busy: boolean) => void;
  onOpenJob: (jobId: string, status: PlanReadingJobStatus) => void;
};
const saved = (status: string) => status === 'needs_review' || status === 'ready';

/** Resumable foreground review: each physical page is persisted independently. */
export function PageReviewPanel(props: Props) {
  const [owner, setOwner] = useState(false);
  const [inventory, setInventory] = useState<PageReviewInventory | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lock = useRef(false);
  const stop = useRef(false);
  const current = useRef('');
  const key = `${props.workspaceId}:${props.projectId}:${props.fileId}:${props.scope}`;
  current.current = key;
  useEffect(() => {
    let active = true;
    bootstrapAuth().then(value => { if (active) setOwner(value.profile.isPlatformAdmin); }).catch(() => { if (active) setOwner(false); });
    return () => { active = false; stop.current = true; current.current = ''; props.onBusyChange(false); };
  }, []);
  const load = async () => {
    if (!props.canWrite || lock.current) return;
    lock.current = true; setBusy(true); props.onBusyChange(true); setError(null);
    try {
      const result = await getPageReviewInventory(props.workspaceId, props.projectId, props.fileId, props.scope, TRADES);
      if (current.current === key) { setInventory(result); setNotice('Page inventory loaded. No AI request was made.'); }
    } catch (err) { if (current.current === key) setError(err instanceof Error ? err.message : 'Page inventory unavailable.'); }
    finally { lock.current = false; if (current.current === key) { setBusy(false); props.onBusyChange(false); } }
  };
  const run = async (pageNumbers: number[]) => {
    if (!props.canWrite || !inventory || lock.current || !pageNumbers.length) return;
    lock.current = true; stop.current = false; setBusy(true); props.onBusyChange(true); setError(null);
    try {
      for (const number of pageNumbers) {
        if (stop.current || current.current !== key) break;
        const existing = inventory.pages.find(page => page.pageNumber === number);
        if (!existing || existing.jobId) continue;
        setNotice(`Reading physical page ${number} of ${inventory.totalPages}. Previously saved pages are preserved.`);
        const job = await startPhysicalPageReading(props.workspaceId, props.projectId, inventory, number);
        if (current.current !== key) return;
        setInventory(previous => previous ? { ...previous, pages: previous.pages.map(page => page.pageNumber === number
          ? { ...page, jobId: job.id, status: job.status, processingError: job.processing_error, findingCount: job.plan_reading_findings.length } : page) } : previous);
        if (!saved(job.status) || job.processing_error) {
          throw new Error('This page already has an in-progress or uncertain request. Reload saved pages; it will not be automatically replayed.');
        }
      }
      if (current.current === key) setNotice(stop.current ? 'Paused. Saved pages can be resumed without repeating them.' : 'Requested page processing finished. Review each page for omissions and measurement accuracy.');
    } catch (err) {
      if (current.current === key) {
        setError(err instanceof Error ? err.message : 'Page review stopped. No automatic retry was made.');
        // Reconcile the server claim after a timeout; never replay a POST here.
        try { const result = await getPageReviewInventory(props.workspaceId, props.projectId, props.fileId, props.scope, TRADES); if (current.current === key) setInventory(result); }
        catch { setNotice('Saved status could not be reloaded. Reload before another attempt.'); setInventory(null); }
      }
    } finally { lock.current = false; if (current.current === key) { setBusy(false); props.onBusyChange(false); } }
  };
  if (!owner) return null;
  const completed = inventory?.pages.filter(page => saved(page.status)).length ?? 0;
  const pending = inventory?.pages.filter(page => !page.jobId).map(page => page.pageNumber) ?? [];
  const chosen = inventory?.pages.find(page => page.pageNumber === selected);
  return <section aria-label="Page-by-page AI review" className="mx-4 sm:mx-6 md:mx-8 mt-5 border border-slate-200 bg-white rounded-xl p-4 space-y-3">
    <div><h3 className="font-semibold text-slate-900">Page-by-page AI review</h3><p className="text-xs text-slate-600 mt-1">Owner validation. Sends one physical PDF page per request, covering all seven supported trades. Original drawings remain unchanged.</p></div>
    <p className="text-xs text-amber-800">Uses metered provider credit and the existing company and daily limits. No automatic retries. Keep this page open while processing; closing it stops subsequent pages, not a request already sent.</p>
    <div className="flex flex-wrap gap-2 items-center">
      <button onClick={load} disabled={!props.canWrite || busy} className="rounded-md border px-3 py-2 text-sm disabled:opacity-50">{busy ? 'Working...' : inventory ? 'Reload saved pages' : 'Load PDF page inventory'}</button>
      {inventory && <>
        <label className="text-sm">Physical page <select aria-label="Page to analyze" value={selected} disabled={busy} onChange={event => setSelected(Number(event.target.value))} className="border rounded p-2">{inventory.pages.map(page => <option key={page.pageNumber} value={page.pageNumber}>{page.pageNumber}</option>)}</select></label>
        <button onClick={() => run([selected])} disabled={!props.canWrite || busy || Boolean(chosen?.jobId)} className="rounded-md border px-3 py-2 text-sm disabled:opacity-50">Analyze selected page</button>
        <button onClick={() => run(pending)} disabled={!props.canWrite || busy || !pending.length} className="rounded-md bg-blue-600 text-white px-3 py-2 text-sm disabled:opacity-50">Analyze remaining pages ({pending.length})</button>
      </>}
      {busy && <button onClick={() => { stop.current = true; setNotice('Pausing after the current request. No subsequent page will start.'); }} className="rounded-md border px-3 py-2 text-sm">Pause after current page</button>}
    </div>
    {notice && <p role="status" className="text-sm text-slate-600">{notice}</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {inventory && <>
      <p className="text-sm font-medium">{completed} of {inventory.totalPages} physical pages have saved results. Complete takeoff is not verified.</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 max-h-64 overflow-y-auto">{inventory.pages.map(page => <div key={page.pageNumber} className="border rounded-md p-2 text-xs space-y-1">
        <strong>Page {page.pageNumber}</strong>
        <p>{page.processingError ? 'Needs attention' : saved(page.status) ? `${page.findingCount ?? '?'} findings - review required` : page.status === 'not_started' ? 'Not started' : 'In progress / verify status'}</p>
        {page.jobId && saved(page.status) && <button disabled={busy} onClick={() => props.onOpenJob(page.jobId!, page.status as PlanReadingJobStatus)} className="underline text-blue-700 disabled:opacity-50" aria-label={`Review findings for page ${page.pageNumber}`}>Review findings</button>}
      </div>)}</div>
      <p className="text-xs text-slate-600">Page processing is not proof of exhaustive extraction. Check repeated facts across sheets before adding quantities. Room floor area is not wall drywall area. Use the original PDF and its AI markers as the reference.</p>
    </>}
  </section>;
}
