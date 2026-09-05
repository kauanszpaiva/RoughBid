import React, { useEffect, useState } from 'react';
import type { Project, UnitType } from '../types';
import { getAiPlanReading, reviewAiFinding, updateProject, type AiFinding, type AiReading } from '../services/api';

export function PlanReadingResults({ project, workspaceId, onUpdateProject }: { project: Project; workspaceId: string | null; onUpdateProject: (p: Project) => void }) {
  const revision = project.revisions.find(r => r.isCurrent) ?? project.revisions.at(-1);
  const jobId = revision?.aiPlanJobId;
  const [reading, setReading] = useState<AiReading | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    setReading(null); setError('');
    if (!workspaceId || !jobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let polls = 0;
    const load = async () => {
      try {
        const data = await getAiPlanReading(workspaceId, jobId);
        if (cancelled) return;
        setReading(data);
        if (['queued', 'processing'].includes(data.status) && polls++ < 40) timer = setTimeout(load, 3000);
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the reading.'); }
    };
    void load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [workspaceId, jobId, refresh, revision?.aiPlanStatus]);

  const review = async (finding: AiFinding, status: 'accepted' | 'rejected', addQuantity = false) => {
    if (!workspaceId || !jobId || !project.remoteId) return;
    setBusy(finding.id); setError('');
    try {
      const reviewed = await reviewAiFinding(workspaceId, jobId, finding.id, status);
      if (addQuantity && finding.quantity !== null && finding.unit) {
        const id = `ai-${finding.id}`;
        const next = { ...project, quantities: project.quantities.some(q => q.id === id) ? project.quantities : [...project.quantities, {
          id, itemNumber: Math.max(0, ...project.quantities.map(q => q.itemNumber)) + 1,
          name: finding.label, quantity: finding.quantity, unit: finding.unit.toUpperCase() as UnitType,
          category: `Reviewed AI · page ${finding.page_number}`,
        }] };
        const appState = { ...next, revisions: next.revisions.map(({ fileUrl: _fileUrl, ...r }) => r) };
        await updateProject(workspaceId, project.remoteId, { appState });
        onUpdateProject(next);
      }
      setReading(current => current ? { ...current, plan_reading_findings: current.plan_reading_findings.map(f => f.id === finding.id ? reviewed : f) } : current);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save your review.'); }
    finally { setBusy(null); }
  };
  if (!jobId) return null;
  const coverage = reading?.output_summary?.coverage;
  return <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4" aria-label="AI plan results">
    <div className="flex justify-between gap-3"><div><h3 className="font-bold text-slate-900">Plan findings</h3><p className="text-xs text-slate-500">Review the source page before accepting. Prices are entered by you.</p></div><button className="text-sm text-blue-700" onClick={() => setRefresh(n => n + 1)}>Refresh results</button></div>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {!reading && !error && <p role="status">Loading saved reading…</p>}
    {reading && <p className="text-sm text-slate-700">Status: {reading.status.replaceAll('_', ' ')}{coverage && ` · Pages inspected: ${coverage.pages_analyzed}/${coverage.pages_requested} · Coverage: ${coverage.completeness_status}`}</p>}
    {reading && <p className="text-xs text-slate-500">Saved reading: {reading.model === 'openrouter/free' ? 'OpenRouter Free' : 'Gemini'}{reading.output_summary?.routed_model && ` · ${reading.output_summary.routed_model}`}{reading.output_summary?.reported_cost === 0 && ' · Reported API cost: $0'}</p>}
    {reading?.processing_error && <p role="alert" className="text-sm text-amber-800">{reading.processing_error}</p>}
    {coverage?.limitations?.length ? <ul className="list-disc pl-5 text-sm text-amber-800">{coverage.limitations.map((s, i) => <li key={i}>{s}</li>)}</ul> : null}
    {reading && !['queued', 'processing'].includes(reading.status) && !reading.plan_reading_findings.length && <p className="text-sm text-slate-600">No findings were returned. Review the PDF and the coverage limitations.</p>}
    <div className="grid gap-3 md:grid-cols-2">{reading?.plan_reading_findings.map(f => {
      const added = project.quantities.some(q => q.id === `ai-${f.id}`);
      const canAdd = f.quantity !== null && Number.isFinite(f.quantity) && f.quantity > 0 && ['SF', 'LF', 'EA', 'CY', 'SY', 'HR', 'LS'].includes(f.unit?.toUpperCase() ?? '');
      return <article key={f.id} className="rounded-lg border border-slate-200 p-4 space-y-2">
        <p className="text-xs text-slate-500">Page {f.page_number ?? 'unknown'} · {Math.round(f.confidence * 100)}% confidence · {f.status.replaceAll('_', ' ')}</p>
        <h4 className="font-semibold text-slate-900">{f.label}</h4>
        <p className="text-sm">{f.quantity !== null ? `${f.quantity} ${f.unit ?? ''}` : f.value_text ?? 'Needs clarification'}</p>
        {f.source_excerpt && <blockquote className="border-l-2 border-blue-200 pl-3 text-xs text-slate-600 select-text">{f.source_excerpt}</blockquote>}
        {reading && ['needs_review', 'ready'].includes(reading.status) && <div className="flex flex-wrap gap-2 text-xs">
          {f.status !== 'rejected' && !added && canAdd && <button disabled={!!busy} onClick={() => void review(f, 'accepted', true)} className="rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50">Accept and add quantity</button>}
          {f.status === 'needs_review' && !canAdd && <button disabled={!!busy} onClick={() => void review(f, 'accepted')} className="rounded border px-3 py-2">Accept finding</button>}
          {f.status === 'needs_review' && <button disabled={!!busy} onClick={() => void review(f, 'rejected')} className="rounded border px-3 py-2">Reject</button>}
          {added && <span className="text-emerald-700">Added to quantities</span>}
          {busy === f.id && <span role="status">Saving…</span>}
        </div>}
      </article>;
    })}</div>
  </section>;
}
