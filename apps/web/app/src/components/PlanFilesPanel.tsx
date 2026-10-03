import React, { useEffect, useState } from 'react';
import { getFullTakeoffRun, getSavedFullReadingQuote, getReadingOrder, type FullTakeoffRun, type ReadingOrder } from '../services/api';
import type { PlanRevision } from '../types';
import { isAiPlanInFlight } from '../utils/aiPlanStatus';
import { planFileCoverage, planFileStatus } from '../utils/planFileCoverage';

type SavedFile = { status?: string | undefined; pages?: number | undefined; run?: FullTakeoffRun | undefined; error?: boolean; loaded: boolean };

/** A project overview reads existing purchases only; selecting a file never starts AI. */
export function PlanFilesPanel({ workspaceId, projectId, revisions, selectedId, selectedFileIds, selectedOrder, disabled, onSelect, onToggle }: {
  workspaceId: string | null; projectId?: string | undefined; revisions: PlanRevision[]; selectedId?: string | undefined; disabled: boolean;
  selectedFileIds: string[]; onToggle: (fileId: string, selected: boolean) => void;
  selectedOrder: ReadingOrder | null;
  onSelect: (revision: PlanRevision, run?: FullTakeoffRun, open?: boolean) => void;
}) {
  const [saved, setSaved] = useState<Record<string, SavedFile>>({});
  const [refresh, setRefresh] = useState(0);
  const signature = revisions.map(revision => `${revision.id}:${revision.remoteFileId}:${revision.aiPlanJobId}`).join('|');
  const purchaseSignature = `${selectedOrder?.id}:${selectedOrder?.status}:${selectedOrder?.items.map(item => `${item.file_id}:${item.status}:${item.full_run_id}`).join('|')}`;
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (disabled) return;
    setSaved({});
    if (!workspaceId || !projectId) return;
    const load = async () => {
      let pending = false;
      // Bounded sequential reads also keep a large upload batch from flooding the API.
      for (const revision of revisions) {
        if (!active) return;
        if (!revision.remoteFileId) continue;
        try {
          const knownItem = selectedOrder?.items.find(item => item.file_id === revision.remoteFileId);
          const standalone = knownItem ?? await getSavedFullReadingQuote(workspaceId, projectId, revision.remoteFileId);
          if (!active) return;
          const order = !standalone ? await getReadingOrder(workspaceId, projectId, { containsFileId: revision.remoteFileId }) : null;
          if (!active) return;
          const quote = standalone ?? order?.items.find(item => item.file_id === revision.remoteFileId) ?? null;
          const runId = quote?.status === 'revoked' ? null : quote?.full_run_id ?? (revision.aiPlanMode === 'full_v2' ? revision.aiPlanJobId : undefined);
          const run = runId ? await getFullTakeoffRun(workspaceId, runId) : undefined;
          if (!active) return;
          const status = run?.status ?? quote?.status ?? revision.aiPlanStatus;
          pending ||= Boolean(status && (isAiPlanInFlight(status) || status === 'paid'));
          setSaved(current => ({ ...current, [revision.id]: { status, run, pages: quote?.full_summary.physicalPageCount ?? revision.pages, loaded: true } }));
        } catch {
          if (!active) return;
          setSaved(current => ({ ...current, [revision.id]: { loaded: true, error: true } }));
        }
      }
      if (active && pending) timer = setTimeout(load, 4000);
    };
    void load();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [workspaceId, projectId, signature, purchaseSignature, refresh, disabled]);

  if (!revisions.length) return null;
  return <section aria-label="Project files and results" className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold text-slate-900">Your files and results</h3>
      <button type="button" onClick={() => setRefresh(value => value + 1)} disabled={disabled} className="text-sm underline disabled:opacity-50">Refresh files</button></div>
    <p className="text-sm text-slate-600">Choose up to 20 PDFs for one price and payment. Select only the revisions you want read. Open each file to review its page results; quantities are not added together automatically.</p>
    <div className="grid gap-3 sm:grid-cols-2">{revisions.map(revision => {
      const value = saved[revision.id];
      const coverage = value?.run ? planFileCoverage(value.run, value.pages) : null;
      const pages = value?.pages ?? revision.pages;
      return <article key={revision.id} aria-label={`File ${revision.fileName}`} className={`min-w-0 rounded-lg border p-3 space-y-2 ${revision.id === selectedId ? 'border-blue-400 bg-blue-50' : 'border-slate-200'}`}>
        <h4 className="text-sm font-semibold break-words">{revision.fileName}</h4>
        {revision.remoteFileId && <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={`Include ${revision.fileName} in reading`} checked={selectedFileIds.includes(revision.remoteFileId)}
          disabled={disabled || revision.processingStatus !== 'ready' || (!selectedFileIds.includes(revision.remoteFileId) && selectedFileIds.length >= 20)} onChange={event => onToggle(revision.remoteFileId!, event.target.checked)} />Include in reading</label>}
        <p className="text-xs text-slate-600">Revision {revision.revisionNumber} · {coverage?.pageCount ?? (pages > 0 ? `${pages} pages` : 'Page count pending')}</p>
        <p className="text-sm" role="status">{value?.error ? 'Status unavailable. Refresh to check saved results.' : !value?.loaded && revision.remoteFileId ? 'Checking saved results…' : !revision.remoteFileId ? 'Upload required' : planFileStatus(value?.status)}</p>
        {coverage ? <p className="text-xs text-slate-600">{coverage.saved}. {coverage.pending}. Missing information is pending, never a zero quantity.</p> : <p className="text-xs text-slate-600">{value?.status === 'revoked' ? 'This purchase cannot start a reading.' : 'Page coverage is available after processing. Uploading alone does not start a paid reading.'}</p>}
        <div className="flex flex-wrap gap-2"><button type="button" onClick={() => onSelect(revision)} disabled={disabled} className="rounded border px-3 py-1.5 text-xs disabled:opacity-50">{revision.id === selectedId ? 'Selected PDF' : 'Select PDF'}</button>
          {value?.run && <button type="button" onClick={() => onSelect(revision, value.run, true)} disabled={disabled} className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white disabled:opacity-50">View results</button>}</div>
      </article>;
    })}</div>
  </section>;
}
