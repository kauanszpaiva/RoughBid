import React, { useEffect, useRef, useState } from 'react';
import { geometryApi, type GeometryCandidate, type GeometryRunDetail, type GeometryRunSummary, type GeometryReviewInput } from '../services/geometry-api';
import { buildGeometryReview, emptyGeometryReview, geometryPreviewPaths, geometryQuantityLabel } from '../utils/geometryReview';
import { reviewIssueMessages } from '../utils/reviewMessages';

export const GeometryCandidatePanel = ({ workspaceId, projectId, fileId, fileSha256, pageNumber, canWrite, onManualCorrection, api = geometryApi }: {
  workspaceId: string; projectId: string; fileId: string; fileSha256: string; pageNumber: number; canWrite: boolean;
  onManualCorrection: (candidate: GeometryCandidate) => void; api?: typeof geometryApi;
}) => {
  const [runs, setRuns] = useState<GeometryRunSummary[]>([]), [runId, setRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GeometryRunDetail | null>(null), [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyGeometryReview), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [reload, setReload] = useState(0), [loading, setLoading] = useState(false), [unavailable, setUnavailable] = useState(false);
  const [moreRuns, setMoreRuns] = useState(false);
  const context = useRef(''), actionLock = useRef(false), needsRead = useRef(false), pending = useRef<{ runId: string; input: GeometryReviewInput } | null>(null);
  const key = `${workspaceId}:${projectId}:${fileId}:${fileSha256}:${pageNumber}`; context.current = key;
  const candidate = detail?.candidates.find(item => item.id === selectedId), preview = geometryPreviewPaths(candidate?.geometry ?? null);
  useEffect(() => { setRuns([]); setRunId(null); setDetail(null); setSelectedId(null); setDraft(emptyGeometryReview()); pending.current = null; needsRead.current = false; setError(null); setNotice(null); }, [key]);
  useEffect(() => {
    let active = true; setLoading(true);
    void Promise.allSettled([api.capability(workspaceId, projectId), api.list(workspaceId, projectId, fileId, pageNumber)]).then(results => {
      if (!active) return;
      const [capability, list] = results;
      setUnavailable(capability.status !== 'fulfilled' || !capability.value.enabled);
      if (list.status === 'fulfilled') { setRuns(list.value.runs); setMoreRuns(list.value.hasMore); setRunId(previous => list.value.runs.some(run => run.id === previous) ? previous : list.value.runs[0]?.id ?? null); }
      else setError(list.reason instanceof Error ? list.reason.message : 'Saved geometry proposals could not be loaded.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [key, reload, api]);
  useEffect(() => {
    if (!runId) return;
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const saved = await api.get(workspaceId, projectId, runId);
        if (!active) return;
        if (saved.run.id !== runId || saved.run.file_id !== fileId) throw new Error('The geometry proposal source could not be verified.');
        const receipt = pending.current;
        if (receipt && (receipt.runId !== runId || saved.candidates.find(item => item.id === receipt.input.candidateId)?.reviewRevision !== receipt.input.expectedRevision)) { pending.current = null; setDraft(emptyGeometryReview()); }
        setDetail(saved); needsRead.current = false; setError(null);
        if (['queued', 'processing', 'waiting'].includes(saved.run.status)) timer = setTimeout(poll, 4_000);
      } catch (cause) { if (active) { setError(cause instanceof Error ? cause.message : 'Saved geometry proposals could not be refreshed.'); if (!(cause && typeof cause === 'object' && 'status' in cause && [401, 403, 404].includes(Number(cause.status)))) timer = setTimeout(poll, 8_000); } }
    };
    void poll(); return () => { active = false; if (timer) clearTimeout(timer); };
  }, [key, runId, reload, api]);
  const handleReview = async (decision: 'accepted' | 'rejected') => {
    if (!canWrite || !candidate || !runId || actionLock.current || needsRead.current) return;
    let input: GeometryReviewInput;
    try {
      if (pending.current?.runId === runId && pending.current.input.candidateId === candidate.id && pending.current.input.decision === decision && pending.current.input.expectedRevision === candidate.reviewRevision) input = pending.current.input;
      else { input = buildGeometryReview(candidate, draft, decision, crypto.randomUUID(), fileSha256, pageNumber); pending.current = { runId, input }; }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Review the source before confirming.'); return; }
    actionLock.current = true; setBusy(true); setError(null);
    try {
      const saved = await api.review(workspaceId, projectId, runId, input);
      if (context.current !== key) return;
      if (saved.candidate.id !== input.candidateId || saved.candidate.status !== input.decision || saved.candidate.reviewRevision !== input.expectedRevision + 1
        || saved.candidate.fileSha256 !== fileSha256 || saved.candidate.physicalPageNumber !== pageNumber) throw new Error('The saved review receipt does not match this source proposal.');
      pending.current = null; setDetail(previous => previous ? { ...previous, candidates: previous.candidates.map(item => item.id === saved.candidate.id ? saved.candidate : item) } : previous);
      setNotice(decision === 'accepted' ? 'Reviewed geometry saved. Refresh accepted quantities in the budget; prices and complete coverage still need evidence.' : 'Proposal rejected. Correct its measurement against the source using the manual review below.');
      if (decision === 'rejected') onManualCorrection(candidate);
      needsRead.current = true; setReload(value => value + 1);
    } catch (cause) { if (context.current === key) { needsRead.current = true; setError(`${cause instanceof Error ? cause.message : 'Review could not be confirmed.'} Refresh saved proposals before retrying.`); } }
    finally { actionLock.current = false; if (context.current === key) setBusy(false); }
  };
  return <section aria-label="Automatic geometry proposals" className="rounded border border-emerald-200 bg-emerald-50 p-3 space-y-3">
    <div className="flex flex-wrap justify-between gap-2"><h4 className="font-semibold text-sm">Automatic geometry proposals</h4><button type="button" disabled={busy || loading} className="text-xs underline disabled:opacity-40" onClick={() => setReload(value => value + 1)}>Refresh saved proposals</button></div>
    <p className="text-xs">Inspect the extraction source and its proposed measurement, then confirm or correct the element. Provider SI measurements are preserved; they are not scaled again.</p>
    {unavailable && <p className="text-xs text-amber-900">Automatic extraction is awaiting authorized configuration. Existing source evidence remains available.</p>}
    {loading && <p role="status" className="text-xs">Loading saved extraction jobs…</p>}
    {(moreRuns || detail?.hasMore) && <p className="text-xs text-amber-900">This view contains a subset of saved extraction jobs or proposals. Further evidence remains outside this view; project coverage is incomplete.</p>}
    {error && <p role="alert" className="text-xs text-red-800">{error}</p>}{notice && <p role="status" className="text-xs">{notice}</p>}
    {runs.length > 1 && <label className="text-xs">Extraction source<select disabled={busy} value={runId ?? ''} className="ml-2 rounded border p-2" onChange={event => { if (actionLock.current) return; setRunId(event.target.value); setDetail(null); setSelectedId(null); setDraft(emptyGeometryReview()); }}>{runs.map((run, index) => <option key={run.id} value={run.id}>{run.provider} extraction {index + 1} - {run.status}</option>)}</select></label>}
    {!runs.length && !loading && <p className="text-xs text-slate-600">No automatic geometry proposals are saved for this source page. Start an authorized takeoff from Plans; manual source review remains available below.</p>}
    {detail && <><p className="text-xs">Extraction: {detail.run.provider} · {detail.run.status}. Coverage remains incomplete until page mapping and human review are resolved.</p>
      {detail.run.error_code && <div className="text-xs text-amber-900"><p>{reviewIssueMessages([detail.run.error_code])[0]}</p><details><summary>Advanced extraction diagnostic</summary><code>{detail.run.error_code}</code></details></div>}
      {detail.run.file_sha256 !== fileSha256 && <p className="text-xs text-amber-900">This extraction uses a different saved source revision. Review the current source before accepting a measurement.</p>}
      {detail.candidates.filter(item => item.physicalPageNumber === pageNumber || item.physicalPageNumber === null).map(item => <div key={item.id} className="rounded bg-white border p-3 text-xs flex flex-wrap justify-between gap-3"><div><strong>{item.label}</strong><p>{item.measurementKind.replaceAll('_', ' ')}: {geometryQuantityLabel(item)} · {item.status}</p><p>Source: {item.provider}. {item.physicalPageNumber === null ? 'Physical page assignment pending.' : `Sheet ${item.physicalPageNumber}.`}</p></div><button type="button" className="rounded border px-3 py-2" disabled={busy} onClick={() => { if (actionLock.current) return; setSelectedId(item.id); setDraft(emptyGeometryReview()); pending.current = null; setNotice(null); }}>Review proposal</button></div>)}
      {candidate && <div className="rounded bg-white border p-3 space-y-3 text-xs"><h5 className="font-semibold">Review: {candidate.label}</h5><p>Proposed measurement: {geometryQuantityLabel(candidate)}.</p>
        <p>Provider coordinate preview. This geometry is not aligned to the PDF page; verify orientation and physical identity against the source.</p>
        {preview ? <svg role="img" aria-label="Provider geometry preview" className="w-full h-48 border bg-slate-50" viewBox={preview.viewBox}>{preview.paths.map((points, index) => <polyline key={index} points={points.map(point => point.join(',')).join(' ')} fill="none" stroke="#047857" strokeWidth={2} vectorEffect="non-scaling-stroke" />)}</svg> : <p>No supported geometry preview is available. Inspect the source artifact and advanced source record.</p>}
        {candidate.reviewReasons.length > 0 && <ul className="list-disc pl-4 text-amber-900">{reviewIssueMessages(candidate.reviewReasons).map(reason => <li key={reason}>{reason}</li>)}</ul>}
        <fieldset disabled={!canWrite || busy || needsRead.current} className="space-y-2">
          {(['geometryReviewed', 'identityReviewed', 'duplicateReviewComplete'] as const).map((field, index) => <label key={field} className="flex gap-2"><input type="checkbox" checked={draft[field]} onChange={event => { pending.current = null; setDraft(previous => ({ ...previous, [field]: event.target.checked })); }} />{['I compared the proposed geometry and measurement with the source.', 'I identified this distinct physical element.', 'I reviewed overlaps and duplicate elements across views.'][index]}</label>)}
          <label className="block">Source check / correction note<textarea maxLength={1200} className="block w-full rounded border p-2" value={draft.reviewNote} onChange={event => { pending.current = null; setDraft(previous => ({ ...previous, reviewNote: event.target.value })); }} /></label>
          <div className="flex flex-wrap gap-2"><button type="button" className="rounded bg-emerald-700 text-white px-3 py-2 disabled:opacity-40" disabled={candidate.quantity === null || candidate.status !== 'candidate'} onClick={() => void handleReview('accepted')}>Confirm reviewed measurement</button><button type="button" className="rounded border px-3 py-2" onClick={() => void handleReview('rejected')}>Correct this proposal</button></div>
        </fieldset>
        <details><summary className="cursor-pointer">Advanced source tracking and geometry</summary><pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(candidate, null, 2)}</pre></details>
      </div>}
    </>}
  </section>;
};
