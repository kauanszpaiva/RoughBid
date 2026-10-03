import React, { useEffect, useRef, useState } from 'react';
import { Camera, Loader2 } from 'lucide-react';
import { ApiError } from '../services/api';
import { beginPhotoUpload, cancelPhotoRun, completePhotoUpload, createPhotoPreview, createPhotoRun, getPhotoCapability,
  getPhotoRun, getPhotoCheckpoint, listPhotoRuns, resumePhotoRun, savePhotoReview, type PhotoCapability, type PhotoRun, type PhotoRunDetail, type PhotoSourceAsset, type PhotoReviewRequest, type PhotoCheckpoint } from '../services/photos-api';
import { buildPhotoHumanReview, canResumePhotoRun, emptyPhotoReviewDraft, isPhotoRunInFlight, photoCheckpointProgress,
  validatePhotoSelection, type PhotoReviewDraft } from '../utils/photoReview';

type UploadSelection = { file: File; asset?: PhotoSourceAsset; status: 'selected' | 'uploading' | 'ready' | 'failed'; error?: string };
const message = (error: unknown) => error instanceof Error ? error.message : 'Photo operation could not be confirmed. Reload saved state.';
const retryRead = (error: unknown) => !(error instanceof ApiError && [401, 403, 404].includes(error.status));

export function PhotoTakeoffPanel({ workspaceId, projectId, canWrite }: { workspaceId: string | null; projectId: string | undefined; canWrite: boolean }) {
  const [capability, setCapability] = useState<PhotoCapability | null>(null);
  const [history, setHistory] = useState<Array<Omit<PhotoRun, 'result'>>>([]);
  const [selection, setSelection] = useState<UploadSelection[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PhotoRunDetail | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({});
  const [previewLoading, setPreviewLoading] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, PhotoReviewDraft>>({});
  const [checkpoints, setCheckpoints] = useState<Record<string, PhotoCheckpoint>>({});
  const [checkpointErrors, setCheckpointErrors] = useState<Record<string, string>>({});
  const [checkpointLoading, setCheckpointLoading] = useState<Record<string, boolean>>({});
  const actionLock = useRef(false);
  const needsRead = useRef(false);
  const requestKey = useRef<string | null>(null);
  const acknowledgedRun = useRef<string | null>(null);
  const previewUrls = useRef(new Map<string, string>());
  const previewRequests = useRef(new Set<string>());
  const loadedDraftRun = useRef<string | null>(null);
  const pendingReview = useRef<{ runId: string; input: PhotoReviewRequest } | null>(null);
  const reviewNeedsRead = useRef(false);
  const checkpointRequests = useRef(new Set<string>());
  const context = useRef('');
  const selectedRun = useRef<string | null>(null);
  const contextKey = `${workspaceId}:${projectId}`;
  context.current = contextKey;
  selectedRun.current = runId;

  useEffect(() => {
    context.current = contextKey;
    setCapability(null); setHistory([]); setSelection([]); setRunId(null); setDetail(null);
    setNotice(null); setReadError(null); setActionError(null); setBusy(null); setDrafts({});
    setPreviews({}); setPreviewErrors({}); setPreviewLoading({});
    requestKey.current = null; acknowledgedRun.current = null; loadedDraftRun.current = null; needsRead.current = false;
    pendingReview.current = null; reviewNeedsRead.current = false;
    return () => { context.current = ''; for (const url of previewUrls.current.values()) URL.revokeObjectURL(url); previewUrls.current.clear(); };
  }, [contextKey]);
  useEffect(() => { setCheckpoints({}); setCheckpointErrors({}); setCheckpointLoading({}); }, [contextKey, runId]);

  useEffect(() => {
    if (!workspaceId || !projectId) return;
    let active = true;
    void Promise.allSettled([getPhotoCapability(workspaceId, projectId), listPhotoRuns(workspaceId, projectId)]).then(results => {
      if (!active) return;
      const [access, runs] = results;
      if (access.status === 'fulfilled') setCapability(access.value);
      else { setCapability(null); setReadError(message(access.reason)); }
      if (runs.status === 'fulfilled') {
        setHistory(runs.value.runs);
        const recovered = requestKey.current ? runs.value.runs.find(run => run.request_key === requestKey.current) : undefined;
        if (recovered && !acknowledgedRun.current) { acknowledgedRun.current = recovered.id; setRunId(recovered.id); }
        else setRunId(current => current ?? runs.value.runs[0]?.id ?? null);
        if (access.status === 'fulfilled') setReadError(null);
        if (!reviewNeedsRead.current) needsRead.current = false;
      } else setReadError(message(runs.reason));
    });
    return () => { active = false; };
  }, [workspaceId, projectId, refresh]);

  useEffect(() => {
    if (!workspaceId || !projectId || !runId) { setDetail(null); return; }
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    setDetail(previous => previous?.run.id === runId ? previous : null);
    const poll = async () => {
      try {
        const saved = await getPhotoRun(workspaceId, projectId, runId);
        if (!active) return;
        setDetail(saved); setReadError(null); needsRead.current = false;
        reviewNeedsRead.current = false;
        if (pendingReview.current && (pendingReview.current.runId !== runId || saved.run.review_revision !== pendingReview.current.input.expectedReviewRevision)) pendingReview.current = null;
        const revisionKey = `${runId}:${saved.run.review_revision ?? 0}`;
        if (loadedDraftRun.current !== revisionKey && saved.run.result) {
          loadedDraftRun.current = revisionKey;
          const restored: Record<string, PhotoReviewDraft> = {};
          for (const observation of saved.run.result.observations) {
            const decision = saved.run.result.decisions?.find(item => item.observationId === observation.id);
            if (!decision) continue;
            restored[observation.id] = { ...emptyPhotoReviewDraft(observation), disposition: decision.disposition,
              quantity: decision.quantity === null ? '' : String(decision.quantity), unit: decision.unit ?? '',
              method: decision.method === 'visible_count' ? 'visible_count' : 'instrument_measurement',
              objectIdentity: decision.objectIdentityKey, calculationMethod: decision.calculationMethod,
              verifiedReading: decision.method === 'instrument_measurement', uncertaintyResolved: decision.uncertaintyResolved,
              crossViewIdentityReviewed: decision.crossViewIdentityReviewed };
          }
          setDrafts(restored);
        }
        if (isPhotoRunInFlight(saved.run.status)) timer = setTimeout(poll, 4000);
      } catch (error) {
        if (!active) return;
        setReadError(message(error));
        if (retryRead(error)) timer = setTimeout(poll, 8000);
      }
    };
    void poll();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [workspaceId, projectId, runId, refresh]);

  const handleSelection = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (actionLock.current) return;
    const files = Array.from(event.target.files ?? []);
    event.currentTarget.value = '';
    if (!files.length) return;
    const error = validatePhotoSelection(files);
    if (error) { setActionError(error); return; }
    setSelection(files.map(file => ({ file, status: 'selected' })));
    requestKey.current = null; acknowledgedRun.current = null;
    setActionError(null); setNotice('Photos selected. Upload them privately before starting an analysis.');
  };

  const handleUpload = async () => {
    if (!canWrite || !capability?.enabled || !capability.ownerAccess || !workspaceId || !projectId || actionLock.current || needsRead.current) return;
    const validation = validatePhotoSelection(selection.map(item => item.file));
    if (validation) { setActionError(validation); return; }
    actionLock.current = true; setBusy('upload'); setActionError(null);
    const update = (index: number, patch: Partial<UploadSelection>) => setSelection(current => current.map((item, position) => position === index ? { ...item, ...patch } : item));
    try {
      for (let index = 0; index < selection.length; index++) {
        if (selection[index]!.asset) continue;
        update(index, { status: 'uploading', error: '' });
        try {
          const selected = selection[index]!.file;
          const reserved = await beginPhotoUpload(workspaceId, projectId, selected);
          if (context.current !== contextKey) return;
          const uploaded = await fetch(reserved.upload.url, { method: reserved.upload.method, headers: reserved.upload.headers,
            body: selected, redirect: 'error', signal: AbortSignal.timeout(120_000) });
          if (!uploaded.ok) throw new Error('The private photo upload could not be completed.');
          const complete = await completePhotoUpload(workspaceId, projectId, reserved.asset.id);
          if (context.current !== contextKey) return;
          update(index, { status: 'ready', asset: complete.asset });
        } catch (error) {
          if (context.current !== contextKey) return;
          update(index, { status: 'failed', error: message(error) });
          setActionError('Some photo uploads were not confirmed. Retry the failed uploads before starting an analysis.');
          return;
        }
      }
      if (context.current === contextKey) setNotice('The photos are verified in private storage. Analysis starts only when you choose Start photo reading.');
    } finally { actionLock.current = false; if (context.current === contextKey) setBusy(null); }
  };

  const handleStart = async () => {
    if (!canWrite || !capability?.enabled || !capability.ownerAccess || !capability.workerReady || !workspaceId || !projectId || actionLock.current || needsRead.current) return;
    if (acknowledgedRun.current) { setRunId(acknowledgedRun.current); setRefresh(value => value + 1); return; }
    const assets = selection.map(item => item.asset);
    if (!assets.length || assets.some(asset => !asset)) { setActionError('Complete every private photo upload first.'); return; }
    if (!requestKey.current) requestKey.current = crypto.randomUUID();
    actionLock.current = true; setBusy('start'); setActionError(null);
    try {
      const saved = await createPhotoRun(workspaceId, projectId, { assetIds: assets.map(asset => asset!.id), requestKey: requestKey.current });
      if (context.current !== contextKey) return;
      acknowledgedRun.current = saved.run.id; setRunId(saved.run.id); setDetail(null); loadedDraftRun.current = null; setDrafts({});
      setHistory(current => [saved.run, ...current.filter(run => run.id !== saved.run.id)]);
      setNotice(saved.enqueued ? 'Photo reading saved and queued. You can leave this page and recover the job later.' : 'The run is saved, but queue acknowledgement was not confirmed. Reload saved progress and explicitly resume this run.');
      setRefresh(value => value + 1);
    } catch (error) {
      if (context.current === contextKey) { needsRead.current = true; setActionError(`${message(error)} Reload saved runs before another start; the original request identity will be reused.`); }
    } finally { actionLock.current = false; if (context.current === contextKey) setBusy(null); }
  };

  const handleRunAction = async (action: 'cancel' | 'resume') => {
    if (!canWrite || !workspaceId || !projectId || !detail || actionLock.current || needsRead.current) return;
    if (action === 'cancel' ? !isPhotoRunInFlight(detail.run.status) || detail.run.cancel_requested : !capability?.workerReady || !canResumePhotoRun(detail)) return;
    actionLock.current = true; setBusy(action); setActionError(null);
    try {
      if (action === 'cancel') await cancelPhotoRun(workspaceId, projectId, detail.run.id);
      else await resumePhotoRun(workspaceId, projectId, detail.run.id);
      if (context.current === contextKey) setRefresh(value => value + 1);
    } catch (error) { if (context.current === contextKey) { needsRead.current = true; setActionError(`${message(error)} Reload saved progress before another action.`); } }
    finally { actionLock.current = false; if (context.current === contextKey) setBusy(null); }
  };

  const handleReview = async () => {
    if (!canWrite || !workspaceId || !projectId || detail?.run.status !== 'needs_review' || !detail.run.result || actionLock.current || needsRead.current) return;
    let input: PhotoReviewRequest;
    try {
      const revision = detail.run.review_revision;
      if (!Number.isSafeInteger(revision) || revision! < 0) throw new Error('The saved review revision is unavailable. Reload this run before writing.');
      if (pendingReview.current?.runId === detail.run.id && pendingReview.current.input.expectedReviewRevision === revision) input = pendingReview.current.input;
      else {
        input = { ...buildPhotoHumanReview(detail.run.result.observations, drafts, () => crypto.randomUUID()),
          expectedReviewRevision: revision!, reviewRequestKey: crypto.randomUUID() };
        pendingReview.current = { runId: detail.run.id, input };
      }
    }
    catch (error) { setActionError(message(error)); return; }
    actionLock.current = true; setBusy('review'); setActionError(null);
    const reviewedRunId = detail.run.id;
    try {
      const saved = await savePhotoReview(workspaceId, projectId, detail.run.id, input);
      if (context.current !== contextKey || selectedRun.current !== reviewedRunId) return;
      pendingReview.current = null;
      setDetail(current => current?.run.id === reviewedRunId ? { ...current, run: { ...current.run, result: saved.review, review_revision: saved.reviewRevision } } : current);
      setNotice('Human measurement review saved. Independent review and sourced pricing still need verification.');
      needsRead.current = true; reviewNeedsRead.current = true; setRefresh(value => value + 1);
    } catch (error) { if (context.current === contextKey && selectedRun.current === reviewedRunId) { needsRead.current = true; reviewNeedsRead.current = true; setActionError(`${message(error)} Reload the saved review before resubmitting.`); } }
    finally { actionLock.current = false; if (context.current === contextKey) setBusy(null); }
  };

  const handlePreview = async (assetId: string) => {
    if (!workspaceId || !projectId || previewRequests.current.has(assetId)) return;
    const source = detail?.assets.find(asset => asset.id === assetId);
    if (!source) return;
    previewRequests.current.add(assetId); setPreviewLoading(current => ({ ...current, [assetId]: true }));
    try {
      const url = await createPhotoPreview(workspaceId, projectId, assetId, source.sha256);
      if (context.current !== contextKey) { URL.revokeObjectURL(url); return; }
      const previous = previewUrls.current.get(assetId); if (previous) URL.revokeObjectURL(previous);
      previewUrls.current.set(assetId, url); setPreviews(current => ({ ...current, [assetId]: url }));
      setPreviewErrors(current => { const next = { ...current }; delete next[assetId]; return next; });
    } catch (error) { if (context.current === contextKey) setPreviewErrors(current => ({ ...current, [assetId]: message(error) })); }
    finally { previewRequests.current.delete(assetId); if (context.current === contextKey) setPreviewLoading(current => ({ ...current, [assetId]: false })); }
  };
  const handleCheckpoint = async (assetId: string) => {
    if (!workspaceId || !projectId || !runId || !detail?.assets.some(asset => asset.id === assetId)) return;
    const requestId = `${contextKey}:${runId}:${assetId}`, requestedRunId = runId;
    if (checkpointRequests.current.has(requestId)) return;
    checkpointRequests.current.add(requestId); setCheckpointLoading(current => ({ ...current, [assetId]: true }));
    try {
      const saved = await getPhotoCheckpoint(workspaceId, projectId, requestedRunId, assetId);
      if (context.current !== contextKey || selectedRun.current !== requestedRunId) return;
      setCheckpoints(current => ({ ...current, [assetId]: saved }));
      setCheckpointErrors(current => { const next = { ...current }; delete next[assetId]; return next; });
    } catch (error) { if (context.current === contextKey && selectedRun.current === requestedRunId) setCheckpointErrors(current => ({ ...current, [assetId]: message(error) })); }
    finally { checkpointRequests.current.delete(requestId); if (context.current === contextKey && selectedRun.current === requestedRunId) setCheckpointLoading(current => ({ ...current, [assetId]: false })); }
  };

  return <section aria-label="Photo takeoff" className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 space-y-4">
    <div><h3 className="font-bold text-slate-900 flex items-center gap-2"><Camera className="h-4 w-4" />Photo evidence and measurements</h3>
      <p className="text-xs text-slate-600 mt-1">Read construction photos separately from the PDF plan. Quantities need a reviewed count or physical measurement reference; unit prices require their own sources.</p></div>
    {(!workspaceId || !projectId) ? <p className="text-sm text-amber-900">Save this project to a signed-in workspace before using photo evidence.</p> : <>
      {!capability && !readError && <p role="status" className="text-sm text-slate-600">Checking photo-processing access.</p>}
      {capability && !capability.enabled && <p className="text-sm text-amber-900">Photo processing is awaiting verified configuration and private-photo authorization. Saved evidence remains available.</p>}
      {capability?.enabled && <div className="text-xs text-slate-700 space-y-1">
        <p>Observation source: {[capability.provider, capability.model].filter(Boolean).join(' / ')}. Provider spend is tracked.</p>
        {!capability.workerReady && <p className="text-amber-900">The durable photo worker is unavailable. Private uploads are allowed; no analysis can start yet.</p>}
        <p>Independent reconciliation and risk review remain pending unless saved evidence explicitly records them.</p>
      </div>}
      {notice && <p role="status" className="rounded-lg bg-blue-50 p-3 text-sm text-blue-900">{notice}</p>}
      {(readError || actionError) && <div role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{readError && <p>Saved state could not be refreshed: {readError}. An existing worker may still be running.</p>}{actionError && <p>{actionError}</p>}</div>}
      <div className="flex flex-wrap items-center gap-3">
        <label className="rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold">Select photos
          <input aria-label="Select construction photos" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={!canWrite || !capability?.enabled || !capability.ownerAccess || Boolean(busy)} onChange={handleSelection} className="block mt-1 text-xs max-w-56 disabled:opacity-50" /></label>
        <button onClick={handleUpload} disabled={!canWrite || !capability?.enabled || !selection.length || Boolean(busy) || needsRead.current || selection.every(item => item.asset)} className="rounded-md border px-3 py-2 text-xs disabled:opacity-50">{busy === 'upload' ? 'Uploading privately…' : 'Upload photos privately'}</button>
        <button onClick={handleStart} disabled={!canWrite || !capability?.workerReady || !selection.length || selection.some(item => !item.asset) || Boolean(busy) || needsRead.current} className="rounded-md bg-slate-900 text-white px-3 py-2 text-xs disabled:opacity-50">{busy === 'start' ? 'Saving photo job…' : acknowledgedRun.current ? 'Open saved photo reading' : 'Start photo reading'}</button>
        <button onClick={() => { setActionError(null); setRefresh(value => value + 1); }} disabled={Boolean(busy)} className="rounded-md border px-3 py-2 text-xs disabled:opacity-50">Reload saved runs</button>
      </div>
      <p className="text-xs text-slate-500">JPEG, PNG or WebP only. Up to 8 photos, 20 MB per photo and 40 MB per batch. A preview, similar views or model agreement cannot establish scale.</p>
      {selection.length > 0 && <ul className="space-y-1 text-xs">{selection.map((item, index) => <li key={index}><strong>{item.file.name}</strong> — {item.status}{item.error ? `: ${item.error}` : ''}</li>)}</ul>}
      {history.length > 0 && <label className="block text-xs font-medium">Saved photo runs<select aria-label="Saved photo runs" value={runId ?? ''} onChange={event => { setRunId(event.target.value); loadedDraftRun.current = null; setDrafts({}); setActionError(null); }} disabled={Boolean(busy)} className="block mt-1 w-full rounded-md border border-slate-300 p-2">{history.map(run => <option key={run.id} value={run.id}>{run.created_at ? new Date(run.created_at).toLocaleString() : run.id} — {run.status.replaceAll('_', ' ')}</option>)}</select></label>}
      {detail && <>
        <div role="status" className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm space-y-1">
          <h4 className="font-semibold flex items-center gap-2">{isPhotoRunInFlight(detail.run.status) && <Loader2 className="h-4 w-4 animate-spin" />}Photo reading: {detail.run.status.replaceAll('_', ' ')}</h4>
          <p>{photoCheckpointProgress(detail)}</p><p>Saved checkpoints remain recoverable after leaving this page. The reading has no overall time deadline.</p>
          {detail.run.error_code && <p className="text-amber-900">Unresolved state: {detail.run.error_code.replaceAll('_', ' ')}.</p>}
          <div className="flex flex-wrap gap-2 pt-1">
            {canWrite && isPhotoRunInFlight(detail.run.status) && !detail.run.cancel_requested && <button onClick={() => handleRunAction('cancel')} disabled={Boolean(busy) || needsRead.current} className="rounded-md border border-rose-300 px-3 py-1.5 text-xs text-rose-800 disabled:opacity-50">Cancel photo reading</button>}
            {canWrite && canResumePhotoRun(detail) && <button onClick={() => handleRunAction('resume')} disabled={!capability?.workerReady || Boolean(busy) || needsRead.current} className="rounded-md border px-3 py-1.5 text-xs disabled:opacity-50">Resume saved photo reading</button>}
          </div>
        </div>
        <PhotoRunEvidence detail={detail} previews={previews} previewErrors={previewErrors} previewLoading={previewLoading} onPreview={handlePreview}
          checkpoints={checkpoints} checkpointErrors={checkpointErrors} checkpointLoading={checkpointLoading} onCheckpoint={handleCheckpoint}
          canReview={canWrite && detail.run.status === 'needs_review'} disabled={Boolean(busy) || needsRead.current} drafts={drafts}
          onDraft={(id, patch) => { pendingReview.current = null; setDrafts(current => { const observation = detail.run.result?.observations.find(item => item.id === id); return observation ? { ...current, [id]: { ...(current[id] ?? emptyPhotoReviewDraft(observation)), ...patch } } : current; }); }} />
        {canWrite && detail.run.status === 'needs_review' && detail.run.result && <button onClick={handleReview} disabled={Boolean(busy) || needsRead.current} className="rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-900 disabled:opacity-50">{busy === 'review' ? 'Saving human review…' : 'Save human measurement review'}</button>}
      </>}
    </>}
  </section>;
}

export const PhotoRunEvidence = ({ detail, previews, previewErrors, previewLoading, onPreview, canReview, disabled, drafts, onDraft,
  checkpoints = {}, checkpointErrors = {}, checkpointLoading = {}, onCheckpoint }: {
  detail: PhotoRunDetail; previews: Record<string, string>; previewErrors: Record<string, string>; previewLoading: Record<string, boolean>;
  onPreview: (assetId: string) => void; canReview: boolean; disabled: boolean; drafts: Record<string, PhotoReviewDraft>;
  onDraft: (observationId: string, patch: Partial<PhotoReviewDraft>) => void;
  checkpoints?: Record<string, PhotoCheckpoint>; checkpointErrors?: Record<string, string>; checkpointLoading?: Record<string, boolean>;
  onCheckpoint?: (assetId: string) => void;
}) => {
  const review = detail.run.result;
  const observations = review?.observations ?? [];
  return <div className="space-y-4">
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 space-y-1">
      <h4 className="font-semibold">Measurement evidence requires human review</h4>
      <p>Independent review: {review?.independentReview ?? 'pending'}. Pricing: missing source prices. No completed budget is implied by this reading.</p>
      {review?.stageStatus && <p>{Object.entries(review.stageStatus).map(([stage, status]) => `${stage.replaceAll('_', ' ')}: ${status}`).join(' · ')}</p>}
      {review?.blockers.length ? <ul className="list-disc pl-4">{review.blockers.map((blocker, index) => <li key={index}>{blocker.replaceAll('_', ' ')}</li>)}</ul> : <p>Check coverage, scale, perspective, hidden surfaces and physical object identity before using any quantities.</p>}
    </div>
    <div className="grid gap-3 sm:grid-cols-2">{detail.assets.map((asset, index) => <figure key={asset.id} className="rounded-lg border border-slate-200 p-3 space-y-2">
      <figcaption className="text-xs font-semibold">Source photo {index + 1} — {asset.widthPixels} × {asset.heightPixels} pixels</figcaption>
      <p className="text-[10px] text-slate-500 break-all">Asset: {asset.id}; revision: {asset.revision.slice(0, 12)}. Pixels locate evidence and do not measure physical dimensions.</p>
      {onCheckpoint && <details className="rounded border p-2 text-xs" onToggle={event => { if (event.currentTarget.open && !checkpoints[asset.id]) onCheckpoint(asset.id); }}>
        <summary className="cursor-pointer font-semibold">Saved checkpoint for this photo</summary>
        {checkpointLoading[asset.id] && <p role="status">Loading saved evidence…</p>}
        {checkpointErrors[asset.id] && <p role="alert" className="text-red-800">{checkpointErrors[asset.id]}</p>}
        {checkpoints[asset.id] && <div className="mt-2 space-y-1"><p>Checkpoint: {checkpoints[asset.id]!.status}. Independent review remains pending.</p>
          {checkpoints[asset.id]!.checkpoint ? <><p>{checkpoints[asset.id]!.checkpoint!.observations.length} saved observations. Quantities are proposals until reviewed.</p>
            {checkpoints[asset.id]!.checkpoint!.observations.map(observation => <p key={observation.id}>{observation.label}: {observation.proposedQuantity === null || !observation.proposedUnit ? 'quantity undetermined' : `unverified ${observation.proposedQuantity} ${observation.proposedUnit}`}</p>)}
            <ul className="list-disc pl-4">{[...checkpoints[asset.id]!.checkpoint!.quality.limitations, ...checkpoints[asset.id]!.checkpoint!.blockers].map((item, at) => <li key={at}>{item.replaceAll('_', ' ')}</li>)}</ul></> : <p>No checkpoint payload has been persisted for this photo yet.</p>}
        </div>}
        <button type="button" disabled={checkpointLoading[asset.id]} className="mt-2 underline disabled:opacity-40" onClick={() => onCheckpoint(asset.id)}>Reload this checkpoint</button>
      </details>}
      {previews[asset.id] && <div className="relative"><img src={previews[asset.id]} alt={`Private construction source photo ${index + 1}`} className="block w-full rounded" referrerPolicy="no-referrer" />
        {observations.flatMap(observation => observation.regions.filter(region => region.sourceAssetId === asset.id).map((region, regionIndex) => <div key={`${observation.id}:${regionIndex}`} title={observation.label} className="absolute border-2 border-blue-500 pointer-events-none" style={{ left: `${region.bbox[0] * 100}%`, top: `${region.bbox[1] * 100}%`, width: `${region.bbox[2] * 100}%`, height: `${region.bbox[3] * 100}%` }} />))}
      </div>}
      <button onClick={() => onPreview(asset.id)} disabled={Boolean(previewLoading[asset.id])} className="underline text-xs text-blue-800 disabled:opacity-50">{previewLoading[asset.id] ? 'Loading private source…' : previews[asset.id] ? 'Reload private source photo' : 'Load private source photo'}</button>
      {previewErrors[asset.id] && <p role="alert" className="text-xs text-rose-800">{previewErrors[asset.id]}</p>}
      {detail.steps.filter(step => step.photo_asset_id === asset.id).map((step, stepIndex) => <div key={stepIndex} className="text-xs space-y-1">
        <p>Observation checkpoint: {step.status}</p>
        {step.result && <><p>Source quality: {step.result.quality.usable ? 'usable for observations' : 'requires another source'}{step.result.quality.additionalViewsNeeded ? '; additional views needed' : ''}.</p>
          {step.result.quality.limitations.map((limit, limitIndex) => <p key={limitIndex} className="text-amber-900">{limit}</p>)}
          {step.result.blockers.map((blocker, blockerIndex) => <p key={blockerIndex} className="text-amber-900">{blocker}</p>)}
          {!review && <p>{step.result.observations.length} observations saved. Consolidated measurement review is pending.</p>}</>}
      </div>)}
      {review?.photoQuality?.filter(quality => quality.sourceAssetId === asset.id).map((quality, qualityIndex) => <div key={qualityIndex} className="text-xs space-y-1">
        <p>Source quality: {quality.usable ? 'usable for observations' : 'requires another source'}{quality.additionalViewsNeeded ? '; additional views needed' : ''}.</p>
        {quality.limitations.map((limit, limitIndex) => <p key={limitIndex} className="text-amber-900">{limit}</p>)}
      </div>)}
    </figure>)}</div>
    {observations.length > 0 && <section aria-label="Photo observations" className="space-y-3"><h4 className="text-sm font-semibold">Observed elements — proposals are unverified</h4>
      {observations.map(observation => {
        const draft = drafts[observation.id] ?? emptyPhotoReviewDraft(observation);
        return <article key={observation.id} className="rounded-lg border border-slate-200 p-3 space-y-2 text-xs">
          <h5 className="font-semibold text-slate-900">{observation.label}</h5>
          <p>{observation.proposedQuantity === null || !observation.proposedUnit ? 'Physical quantity is undetermined.' : `Unverified proposal: ${observation.proposedQuantity} ${observation.proposedUnit}.`} Method: {observation.method.replaceAll('_', ' ')}.</p>
          <p>Evidence regions: {observation.regions.map(region => `photo ${detail.assets.findIndex(asset => asset.id === region.sourceAssetId) + 1}, surface ${region.surfaceKey}`).join('; ')}.</p>
          {observation.uncertainty.length > 0 && <ul className="list-disc pl-4 text-amber-900">{observation.uncertainty.map((uncertainty, index) => <li key={index}>{uncertainty.replaceAll('_', ' ')}</li>)}</ul>}
          {canReview && <fieldset disabled={disabled} className="border-t border-slate-100 pt-2 space-y-2"><legend className="text-xs font-semibold">Human review for {observation.label}</legend>
            <label className="block">Decision<select aria-label={`Review decision for ${observation.label}`} value={draft.disposition} onChange={event => onDraft(observation.id, { disposition: event.target.value as PhotoReviewDraft['disposition'] })} className="ml-2 rounded border p-1"><option value="unreviewed">Leave unresolved</option><option value="approved">Review a count or instrument measurement</option><option value="rejected">Reject this observation</option></select></label>
            {draft.disposition === 'approved' && <div className="space-y-2">
              <div className="flex flex-wrap gap-2"><label>Measurement method<select value={draft.method} onChange={event => onDraft(observation.id, { method: event.target.value as PhotoReviewDraft['method'] })} className="block rounded border p-1"><option value="visible_count">Human-checked visible count</option><option value="instrument_measurement">Instrument reading</option></select></label>
                <label>Reviewed quantity<input aria-label={`Reviewed quantity for ${observation.label}`} inputMode="decimal" value={draft.quantity} onChange={event => onDraft(observation.id, { quantity: event.target.value })} className="block w-28 rounded border p-1" placeholder="Enter a reading" /></label>
                <label>Unit<select value={draft.unit} onChange={event => onDraft(observation.id, { unit: event.target.value })} className="block rounded border p-1"><option value="">Select unit</option>{['EA', 'SF', 'LF', 'CY', 'SY', 'CF', 'TON'].map(unit => <option key={unit}>{unit}</option>)}</select></label></div>
              <label className="block">Physical object identity<input value={draft.objectIdentity} onChange={event => onDraft(observation.id, { objectIdentity: event.target.value })} className="block w-full rounded border p-1" placeholder="Stable identity for this physical surface or element" /></label>
              <label className="block">Reading source and calculation<textarea value={draft.calculationMethod} onChange={event => onDraft(observation.id, { calculationMethod: event.target.value })} className="block w-full rounded border p-1" placeholder="Describe instrument, measurement location, units, or how you checked the count." /></label>
              {draft.method === 'instrument_measurement' && <label className="flex items-center gap-2"><input type="checkbox" checked={draft.verifiedReading} onChange={event => onDraft(observation.id, { verifiedReading: event.target.checked })} />I verified this instrument reading on the identified source surface.</label>}
              <label className="flex items-center gap-2"><input type="checkbox" checked={draft.uncertaintyResolved} onChange={event => onDraft(observation.id, { uncertaintyResolved: event.target.checked })} />I resolved the listed uncertainties for this quantity.</label>
              {detail.assets.length > 1 && <label className="flex items-center gap-2"><input type="checkbox" checked={draft.crossViewIdentityReviewed} onChange={event => onDraft(observation.id, { crossViewIdentityReviewed: event.target.checked })} />If this object appears in several views, I checked its identity and ensured its quantity is not duplicated.</label>}
              <p className="text-slate-500">The instrument reference is bound to the first identified source region. Enter the physical reading in the selected unit; photo pixels are not converted to length or area.</p>
            </div>}
          </fieldset>}
        </article>;
      })}
    </section>}
    {review && <section aria-label="Human-reviewed photo measurements" className="rounded-lg border border-slate-200 p-3 text-xs space-y-2"><h4 className="font-semibold">Human-reviewed measurements</h4>
      {!review.approvedMeasurements.length && <p>No measurement has been approved. Missing quantities remain undetermined.</p>}
      {review.approvedMeasurements.map(measurement => <div key={measurement.id} className="rounded bg-slate-50 p-2"><strong>{measurement.objectIdentityKey}: {measurement.quantity} {measurement.unit}</strong><p>{measurement.calculationMethod}</p><p>Sources: {measurement.sourceRegions.length} region(s); reviewed by {measurement.reviewerIds.length} reviewer(s). Pricing remains missing.</p></div>)}
      <p>No estimate items or price totals are created from this photo review.</p>
    </section>}
  </div>;
};
