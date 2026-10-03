import React, { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { createDocumentPreviewUrl } from '../services/api';
import { getNativePlanCandidates, getPlanMeasurements, getSavedPlanMeasurement, savePlanMeasurement, type NativePlanCandidate,
  type PlanMeasurementContext, type PlanMeasurementRow } from '../services/planmeasurements-api';
import { buildPlanMeasurementInput, draftFromSavedPlanMeasurement, emptyPlanMeasurementDraft, planPointFromPointer,
  planReferencePdfLength, planRegionFromPoints, planViewportMatches, pointInsidePlanRegion, isUsablePlanRegion,
  type PlanMeasurementDraft, type PlanPoint } from '../utils/planMeasurementReview';
import { downloadVerifiedPlanPdf } from '../utils/verifiedPlanPdf';
import { GeometryCandidatePanel } from './GeometryCandidatePanel';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
type CaptureMode = 'region' | 'geometry' | 'reference-0' | 'reference-1' | null;
const message = (error: unknown) => error instanceof Error ? error.message : 'The saved measurement could not be confirmed.';
const fieldClass = 'w-full rounded border border-slate-300 bg-white p-2 text-xs disabled:opacity-50';
const buttonClass = 'rounded border border-slate-300 px-3 py-2 text-xs font-semibold disabled:opacity-40';

export const PlanTrace = ({ type, points, color = '#2563eb' }: { type: string; points: PlanPoint[]; color?: string }) => {
  if (!points.length) return null;
  const attributes = { stroke: color, strokeWidth: 2, vectorEffect: 'non-scaling-stroke' as const, fill: 'none' };
  if (['point', 'count'].includes(type)) return <circle cx={points[0]![0]} cy={points[0]![1]} r={0.006} fill={color} />;
  if (type === 'rectangle' && points.length === 2) {
    const region = planRegionFromPoints(points[0]!, points[1]!);
    return region ? <rect x={region[0]} y={region[1]} width={region[2]} height={region[3]} {...attributes} /> : null;
  }
  const values = points.map(point => point.join(',')).join(' ');
  return type === 'polygon' ? <polygon points={values} {...attributes} /> : <polyline points={values} {...attributes} />;
};

export const PlanMeasurementPanel = ({ workspaceId, runId, pageNumber, canWrite = false }: {
  workspaceId: string; runId: string; pageNumber: number; canWrite?: boolean;
}) => {
  const [context, setContext] = useState<PlanMeasurementContext | null>(null);
  const [rows, setRows] = useState<PlanMeasurementRow[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [candidates, setCandidates] = useState<NativePlanCandidate[]>([]);
  const [candidateNotice, setCandidateNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<PlanMeasurementDraft>(() => emptyPlanMeasurementDraft(crypto.randomUUID()));
  const [mode, setMode] = useState<CaptureMode>(null);
  const [pendingRegionPoint, setPendingRegionPoint] = useState<PlanPoint | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [source, setSource] = useState<{ fileId: string; fileSha256: string } | null>(null);
  const [previewStatus, setPreviewStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [previewIdentity, setPreviewIdentity] = useState('');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [availableWidth, setAvailableWidth] = useState(600);
  const [zoom, setZoom] = useState(1);
  const [pageSize, setPageSize] = useState({ width: 600, height: 780 });
  const canvasRef = useRef<HTMLCanvasElement>(null), viewportRef = useRef<HTMLDivElement>(null);
  const saveInFlight = useRef(false), needsRead = useRef(false), activeContext = useRef('');
  const key = `${workspaceId}:${runId}:${pageNumber}`;
  activeContext.current = key;
  const fileId = source?.fileId, fileSha256 = source?.fileSha256;
  const pageIdentity = context ? `${context.fileSha256}:${context.sheet.pageSha256}:${pageNumber}:${context.sheet.displayWidthPoints}:${context.sheet.displayHeightPoints}` : '';
  const previewReady = previewStatus === 'ready' && !!pageIdentity && previewIdentity === pageIdentity;

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const updateWidth = () => setAvailableWidth(Math.max(180, (element.clientWidth || 632) - 32));
    updateWidth();
    const observer = new ResizeObserver(updateWidth); observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    activeContext.current = key;
    setContext(null); setRows([]); setNextOffset(null); setCandidates([]); setCandidateNotice(null);
    setDraft(emptyPlanMeasurementDraft(crypto.randomUUID())); setMode(null); setPendingRegionPoint(null);
    setError(null); setNotice(null); setBusy('load'); setNeedsReload(false); needsRead.current = false;
    void getPlanMeasurements(workspaceId, runId, pageNumber).then(result => {
      if (!cancelled) { setContext(result); setSource({ fileId: result.fileId, fileSha256: result.fileSha256 }); setRows(result.measurements); setNextOffset(result.nextOffset); }
    }).catch(cause => { if (!cancelled) setError(message(cause)); })
      .finally(() => { if (!cancelled) setBusy(null); });
    return () => { cancelled = true; if (activeContext.current === key) activeContext.current = ''; };
  }, [workspaceId, runId, pageNumber]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let loadingTask: ReturnType<typeof pdfjs.getDocument> | undefined;
    setPdf(null); setPreviewStatus('loading'); setPreviewError(null);
    if (!fileId || !fileSha256) return () => controller.abort();
    void (async () => {
      try {
        const preview = await createDocumentPreviewUrl(workspaceId, fileId);
        if (cancelled) return;
        const bytes = await downloadVerifiedPlanPdf(preview, fileSha256, AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]));
        if (cancelled) return;
        loadingTask = pdfjs.getDocument({ data: bytes });
        const loaded = await loadingTask.promise;
        if (!cancelled) setPdf(loaded);
      } catch (cause) { if (!cancelled) { setPreviewStatus('failed'); setPreviewError(message(cause)); } }
    })();
    return () => { cancelled = true; controller.abort(); void loadingTask?.destroy(); };
  }, [workspaceId, fileId, fileSha256]);

  useEffect(() => {
    if (!pdf || !context) return;
    let cancelled = false;
    let task: ReturnType<pdfjs.PDFPageProxy['render']> | undefined;
    setPreviewStatus('loading'); setPreviewError(null);
    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        if (!planViewportMatches(base.width, base.height, context)) throw new Error('The PDF crop or rotation differs from the measurement coordinate system. Source reconciliation is required.');
        const viewport = page.getViewport({ scale: availableWidth / base.width * zoom });
        const ratio = Math.min(window.devicePixelRatio || 1, 2), staging = document.createElement('canvas');
        staging.width = Math.ceil(viewport.width * ratio); staging.height = Math.ceil(viewport.height * ratio);
        if (staging.width * staging.height > 16_000_000) throw new Error('This preview is too large. Reduce zoom before tracing.');
        const drawing = staging.getContext('2d');
        if (!drawing) throw new Error('PDF drawing is unavailable in this browser.');
        task = page.render({ canvas: staging, canvasContext: drawing, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
        await task.promise;
        if (cancelled || !canvasRef.current) return;
        const canvas = canvasRef.current; canvas.width = staging.width; canvas.height = staging.height;
        canvas.getContext('2d')?.drawImage(staging, 0, 0);
        setPageSize({ width: viewport.width, height: viewport.height }); setPreviewIdentity(pageIdentity); setPreviewStatus('ready');
      } catch (cause) { if (!cancelled) { setPreviewStatus('failed'); setPreviewError(message(cause)); } }
    })();
    return () => { cancelled = true; task?.cancel(); };
  }, [pdf, context?.sheet.pageSha256, context?.sheet.displayWidthPoints, context?.sheet.displayHeightPoints, pageNumber, availableWidth, zoom]);

  const handleReload = async (append = false) => {
    if (busy || saveInFlight.current || append && nextOffset === null) return;
    setBusy('load'); setError(null);
    try {
      let reconciled: PlanMeasurementRow | undefined;
      if (!append && needsRead.current) {
        const exact = await getSavedPlanMeasurement(workspaceId, runId, pageNumber, draft.measurementId);
        if (activeContext.current !== key) return;
        reconciled = exact.measurements.find(row => row.id === draft.measurementId);
      }
      const result = await getPlanMeasurements(workspaceId, runId, pageNumber, append ? nextOffset! : 0);
      if (activeContext.current !== key) return;
      setContext(result); setRows(previous => append ? [...previous, ...result.measurements] : result.measurements); setNextOffset(result.nextOffset);
      if (!append) {
        const saved = reconciled ?? result.measurements.find(row => row.id === draft.measurementId);
        if (needsRead.current && saved) setDraft(draftFromSavedPlanMeasurement(saved));
        const concurrentReview = saved && saved.review_revision > draft.expectedRevision + 1;
        needsRead.current = false; setNeedsReload(false); setNotice(concurrentReview ? 'A newer review was saved. Inspect the restored evidence before editing it.' : 'Saved measurements reloaded.');
      }
    } catch (cause) { if (activeContext.current === key) setError(message(cause)); }
    finally { if (activeContext.current === key) setBusy(null); }
  };
  const handleCandidates = async () => {
    if (!context || busy) return;
    setBusy('candidates'); setError(null);
    try {
      const result = await getNativePlanCandidates(workspaceId, runId, pageNumber);
      if (activeContext.current !== key) return;
      if (result.fileSha256 !== context.fileSha256 || result.sheet.pageSha256 !== context.sheet.pageSha256) throw new Error('The candidate source revision changed. Reload saved context.');
      setCandidates(result.candidates);
      setCandidateNotice(`${result.candidates.length} candidates${result.truncated ? '; extraction was bounded and may omit candidates' : ''}. ${result.limitations.join(' ')}`);
    } catch (cause) { if (activeContext.current === key) setError(message(cause)); }
    finally { if (activeContext.current === key) setBusy(null); }
  };
  const chooseCandidate = (candidate: NativePlanCandidate) => {
    if (!canWrite || busy || needsRead.current || !context || candidate.pageSha256 !== context.sheet.pageSha256) return;
    if (!isUsablePlanRegion(candidate.bbox)) { setNotice('This candidate has no usable enclosing region. Select a region around the actual element manually before tracing.'); return; }
    const next = emptyPlanMeasurementDraft(crypto.randomUUID());
    // Selecting a bbox only locates evidence. It never traces or measures its surface.
    setDraft({ ...next, sourceKind: 'native_vector_candidate', sourceCandidateId: candidate.id, regionBounds: candidate.bbox });
    setPendingRegionPoint(null); setMode(null); setNotice('Candidate region selected. Trace the actual physical element and review its boundary before accepting a quantity.'); setError(null);
  };
  const startCapture = (nextMode: CaptureMode) => {
    if (!canWrite || busy || needsRead.current || !previewReady || nextMode !== 'region' && !draft.regionBounds) return;
    setMode(nextMode); setPendingRegionPoint(null); setError(null);
    if (nextMode === 'geometry') setDraft(previous => ({ ...previous, points: [], geometryReviewed: false, boundaryReviewed: false, decision: 'candidate' }));
    if (nextMode?.startsWith('reference-')) {
      const index = Number(nextMode.slice(-1));
      setDraft(previous => ({ ...previous, references: previous.references.map((reference, at) => at === index ? { ...reference, referenceLine: [], independenceVerified: false } : reference), decision: 'candidate' }));
    }
  };
  const handlePointer = (event: React.MouseEvent<SVGSVGElement>) => {
    if (!canWrite || busy || needsRead.current || !mode || !previewReady) return;
    const point = planPointFromPointer(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
    if (!point) return;
    if (mode === 'region') {
      if (!pendingRegionPoint) { setPendingRegionPoint(point); return; }
      const region = planRegionFromPoints(pendingRegionPoint, point);
      if (!region) { setError('Select two distinct corners of a region with width and height.'); return; }
      setDraft(previous => ({ ...previous, regionBounds: region, points: [], sourceKind: 'manual_trace', sourceCandidateId: null,
        geometryReviewed: false, boundaryReviewed: false, identityReviewed: false, duplicateReviewComplete: false, decision: 'candidate',
        references: previous.references.map(reference => ({ ...reference, referenceLine: [], independenceVerified: false })) }));
      setPendingRegionPoint(null); setMode(null); return;
    }
    if (!draft.regionBounds || !pointInsidePlanRegion(point, draft.regionBounds)) { setError('Trace points must be inside the reviewed region.'); return; }
    if (mode === 'geometry') {
      if (draft.points.length >= 128) { setError('The trace is bounded to 128 points. Simplify the actual boundary.'); return; }
      const points = [...draft.points, point]; setDraft(previous => ({ ...previous, points, geometryReviewed: false, boundaryReviewed: false, decision: 'candidate' }));
      if (['point', 'count'].includes(draft.geometryType) || ['line', 'rectangle'].includes(draft.geometryType) && points.length === 2) setMode(null);
    } else {
      const index = Number(mode.slice(-1)), points = [...(draft.references[index]?.referenceLine ?? []), point];
      setDraft(previous => ({ ...previous, decision: 'candidate', references: previous.references.map((reference, at) => at === index ? { ...reference, referenceLine: points, independenceVerified: false } : reference) }));
      if (points.length === 2) setMode(null);
    }
  };
  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canWrite || !context || busy || saveInFlight.current || needsRead.current || !previewReady) return;
    let input;
    try { input = buildPlanMeasurementInput(draft, context); } catch (cause) { setError(message(cause)); return; }
    saveInFlight.current = true; setBusy('save'); setError(null); setNotice(null);
    try {
      const result = await savePlanMeasurement(workspaceId, runId, input);
      if (activeContext.current !== key) return;
      setRows(previous => [result.measurement, ...previous.filter(row => row.id !== result.measurement.id)]);
      setDraft(draftFromSavedPlanMeasurement(result.measurement));
      setNotice(result.measurement.quantity === null ? 'Candidate saved. Quantity is undetermined.' : 'Reviewed quantity saved by the server. Scope coverage and pricing remain pending.');
    } catch (cause) {
      if (activeContext.current === key) { needsRead.current = true; setNeedsReload(true); setError(`${message(cause)} Reload saved measurements before trying this write again.`); }
    } finally { saveInFlight.current = false; if (activeContext.current === key) setBusy(null); }
  };
  const changeDraft = (patch: Partial<PlanMeasurementDraft>) => setDraft(previous => ({ ...previous, ...patch }));
  const changeReference = (index: number, patch: Partial<PlanMeasurementDraft['references'][number]>) => setDraft(previous => ({ ...previous,
    decision: 'candidate', references: previous.references.map((reference, at) => at === index ? { ...reference, ...patch } : reference) }));
  const writable = canWrite && !busy && !needsReload && previewReady;
  const count = ['point', 'count'].includes(draft.geometryType);

  return <section aria-label={`Measurement review for sheet ${pageNumber}`} className="rounded-lg border border-blue-200 bg-white p-4 space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-bold">Sheet {pageNumber}: reviewed geometry</h3><p className="text-xs text-slate-600">Saved quantities cover selected elements only. Whole-sheet coverage, compositions and price sources remain pending.</p></div>
      <button type="button" className={buttonClass} disabled={!!busy} onClick={() => void handleReload()}>Reload saved measurements</button></div>
    {error && <p role="alert" className="rounded bg-red-50 p-3 text-xs text-red-800">{error}</p>}
    {notice && <p role="status" className="rounded bg-blue-50 p-3 text-xs text-blue-800">{notice}</p>}
    {context?.projectId && <GeometryCandidatePanel workspaceId={workspaceId} projectId={context.projectId} fileId={context.fileId} fileSha256={context.fileSha256} pageNumber={pageNumber} canWrite={canWrite}
      onManualCorrection={candidate => { const next = emptyPlanMeasurementDraft(crypto.randomUUID()); setDraft({ ...next, label: candidate.label, sourceExcerpt: `Correction of ${candidate.provider} geometry proposal for ${candidate.label}. Verify the actual PDF source; provider coordinates are not a PDF trace.` }); setMode(null); setPendingRegionPoint(null); setNotice('Trace the corrected element on the source page and document its measurement evidence.'); }} />}
    <div className="flex flex-wrap gap-2 items-center">
      <button type="button" className={buttonClass} disabled={!context || !!busy} onClick={() => void handleCandidates()}>Find native PDF candidates</button>
      <label className="text-xs">Zoom <select className="ml-2 border rounded p-1" value={zoom} onChange={event => setZoom(Number(event.target.value))}>{[0.5, 0.75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value * 100}%</option>)}</select></label>
      <span className="text-xs text-slate-500">{busy === 'candidates' ? 'Reading local PDF geometry…' : previewStatus === 'loading' ? 'Loading verified PDF revision…' : previewStatus === 'ready' ? 'Source fingerprint and page dimensions verified' : 'Source preview unavailable'}</span>
    </div>
    {previewError && <p role="alert" className="text-xs text-red-800">{previewError}</p>}
    <div ref={viewportRef} className="max-h-[70vh] min-h-40 overflow-auto border rounded bg-slate-100 p-4">
      <div className="relative bg-white" style={{ width: pageSize.width, height: pageSize.height, visibility: previewReady ? 'visible' : 'hidden' }}>
        <canvas ref={canvasRef} style={{ width: pageSize.width, height: pageSize.height }} aria-label={`Private PDF sheet ${pageNumber}`} />
        <svg role="img" aria-label="Drawing measurement overlay" viewBox="0 0 1 1" preserveAspectRatio="none" className={`absolute inset-0 h-full w-full ${mode ? 'cursor-crosshair' : ''}`} onClick={handlePointer}>
          {candidates.map(candidate => <rect key={candidate.id} x={candidate.bbox[0]} y={candidate.bbox[1]} width={candidate.bbox[2]} height={candidate.bbox[3]} fill="none" stroke="#94a3b8" strokeDasharray="4 3" strokeWidth={1} vectorEffect="non-scaling-stroke" />)}
          {draft.regionBounds && <rect x={draft.regionBounds[0]} y={draft.regionBounds[1]} width={draft.regionBounds[2]} height={draft.regionBounds[3]} fill="none" stroke="#7c3aed" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
          <PlanTrace type={draft.geometryType} points={draft.points} />
          {draft.references.map((reference, index) => <PlanTrace key={index} type="line" points={reference.referenceLine} color={index === 0 ? '#059669' : '#d97706'} />)}
          {pendingRegionPoint && <circle cx={pendingRegionPoint[0]} cy={pendingRegionPoint[1]} r={0.006} fill="#7c3aed" />}
        </svg>
      </div>
    </div>
    {candidateNotice && <p className="text-xs text-slate-600">{candidateNotice}</p>}
    {candidates.some(candidate => !isUsablePlanRegion(candidate.bbox)) && <p className="text-xs text-amber-800">Line/point candidates without an enclosing area require a manually selected region around the actual element.</p>}
    {candidates.length > 0 && <details><summary className="text-xs cursor-pointer font-semibold">Choose candidate region ({candidates.length})</summary><div className="mt-2 flex flex-wrap gap-2">{candidates.map((candidate, index) => <button type="button" className={buttonClass} disabled={!writable || !isUsablePlanRegion(candidate.bbox)} key={candidate.id} onClick={() => chooseCandidate(candidate)}>{index + 1}: {candidate.kind.replaceAll('_', ' ')} · {isUsablePlanRegion(candidate.bbox) ? 'quantity undetermined' : 'select enclosing region manually'}</button>)}</div></details>}
    <form onSubmit={event => void handleSave(event)} className="space-y-4">
      <fieldset disabled={!writable} className="space-y-4">
        <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} onClick={() => { setDraft(emptyPlanMeasurementDraft(crypto.randomUUID())); setMode(null); setPendingRegionPoint(null); setError(null); setNotice(null); }}>New physical element</button>
          <button type="button" className={buttonClass} onClick={() => startCapture('region')}>Select region: two corners</button>
          <label className="text-xs">Geometry <select value={draft.geometryType} className="ml-2 border rounded p-2" onChange={event => changeDraft({ geometryType: event.target.value as PlanMeasurementDraft['geometryType'], points: [], geometryReviewed: false, boundaryReviewed: false, decision: 'candidate' })}>{['line', 'polyline', 'polygon', 'rectangle', 'point'].map(type => <option key={type} value={type}>{type === 'point' ? 'One distinct physical element (EA)' : type}</option>)}</select></label>
          <button type="button" className={buttonClass} disabled={!draft.regionBounds} onClick={() => startCapture('geometry')}>Trace actual element</button>
          {mode && <button type="button" className={buttonClass} onClick={() => { setMode(null); setPendingRegionPoint(null); }}>Finish tracing</button>}</div>
        <p className="text-xs text-slate-600">{mode === 'region' ? 'Click two opposite corners of the reviewed region.' : mode === 'geometry' ? 'Click the actual boundary points. Polygon/polyline: finish tracing after the last point.' : mode?.startsWith('reference-') ? 'Click both ends of the visible reference dimension inside this region.' : 'Detected boxes are evidence locations. Trace the actual element; boxes do not establish surface area.'}</p>
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="text-xs">Element label<input className={fieldClass} value={draft.label} maxLength={240} onChange={event => changeDraft({ label: event.target.value })} /></label>
          <label className="text-xs">Work category<select className={fieldClass} value={draft.canonicalTrade} onChange={event => changeDraft({ canonicalTrade: event.target.value, identityReviewed: false, duplicateReviewComplete: false, decision: 'candidate' })}>{['unclassified', 'drywall', 'painting', 'flooring', 'concrete', 'masonry', 'roofing', 'framing', 'openings', 'electrical', 'plumbing', 'hvac'].map(category => <option key={category} value={category}>{category === 'unclassified' ? 'Choose a category when known' : category}</option>)}</select></label>
          {rows.length > 0 && <label className="text-xs">Same physical element as an earlier review<select className={fieldClass} value={rows.find(row => row.canonical_element_key === draft.canonicalElementKey && row.canonical_trade === draft.canonicalTrade)?.id ?? ''} onChange={event => { const previous = rows.find(row => row.id === event.target.value); changeDraft({ canonicalElementKey: previous?.canonical_element_key ?? `element:${draft.measurementId}`, canonicalTrade: previous?.canonical_trade ?? draft.canonicalTrade, identityReviewed: false, duplicateReviewComplete: false, decision: 'candidate' }); }}><option value="">A new distinct physical element</option>{rows.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}</select></label>}
        </div>
        <details className="rounded border p-3"><summary className="cursor-pointer text-xs">Advanced identifiers and source tracking</summary><p className="mt-2 text-xs text-slate-500">Identifiers are generated automatically. Reuse an identity only for the same physical element across views or sheets.</p><div className="grid sm:grid-cols-2 gap-3 mt-3">
          <label className="text-xs">Stable region ID<input className={fieldClass} value={draft.regionKey} maxLength={120} placeholder="first-floor:north-wing" onChange={event => changeDraft({ regionKey: event.target.value })} /></label>
          <label className="text-xs">Trade ID<input className={fieldClass} value={draft.canonicalTrade} maxLength={80} placeholder="drywall" onChange={event => changeDraft({ canonicalTrade: event.target.value, identityReviewed: false, duplicateReviewComplete: false, decision: 'candidate' })} /></label>
          <label className="text-xs">Distinct physical element ID across sheets<input className={fieldClass} value={draft.canonicalElementKey} maxLength={120} placeholder="level-1:north-wall:segment-01" onChange={event => changeDraft({ canonicalElementKey: event.target.value, identityReviewed: false, duplicateReviewComplete: false, decision: 'candidate' })} /></label>
        </div></details>
        <label className="block text-xs">Source evidence and interpretation<textarea className={fieldClass} value={draft.sourceExcerpt} maxLength={1200} onChange={event => changeDraft({ sourceExcerpt: event.target.value })} /></label>
        {!count && <div className="rounded border p-3 space-y-3"><h4 className="font-semibold text-xs">Actual measured boundary</h4>
          <label className="block text-xs">Boundary method<select className={fieldClass} value={draft.boundaryMethod} onChange={event => changeDraft({ boundaryMethod: event.target.value as PlanMeasurementDraft['boundaryMethod'], boundaryReviewed: false, decision: 'candidate' })}><option value="human_trace">Trace of actual physical boundary</option><option value="verified_rectangular_surface" disabled={draft.geometryType !== 'rectangle'}>Explicitly verified rectangular surface</option></select></label>
          <label className="block text-xs">Explain which physical boundary was verified<textarea className={fieldClass} maxLength={1200} value={draft.boundaryExcerpt} onChange={event => changeDraft({ boundaryExcerpt: event.target.value, boundaryReviewed: false, decision: 'candidate' })} /></label>
          <label className="flex gap-2 text-xs"><input type="checkbox" checked={draft.boundaryReviewed} onChange={event => changeDraft({ boundaryReviewed: event.target.checked })} />I checked the actual boundary. A candidate box is accepted as a rectangle only when the physical surface itself is verified rectangular.</label>
        </div>}
        {!count && <div className="grid sm:grid-cols-2 gap-3">{draft.references.map((reference, index) => <div className="rounded border p-3 space-y-2" key={index}>
          <h4 className="text-xs font-semibold">Independent scale reference {index + 1}</h4>
          <button type="button" className={buttonClass} disabled={!draft.regionBounds || index > 1} onClick={() => startCapture(index === 0 ? 'reference-0' : 'reference-1')}>Trace reference line</button>
          <p className="text-xs text-slate-500">{context && planReferencePdfLength(reference.referenceLine, context)?.toFixed(3) || 'Undetermined'} PDF points</p>
          <details><summary className="cursor-pointer text-xs">Advanced reference identifier</summary><label className="block text-xs">Source ID<input className={fieldClass} value={reference.sourceId} maxLength={120} onChange={event => changeReference(index, { sourceId: event.target.value, independenceVerified: false })} /></label></details>
          <label className="block text-xs">Source type<select className={fieldClass} value={reference.sourceType} onChange={event => changeReference(index, { sourceType: event.target.value as typeof reference.sourceType, independenceVerified: false })}>{['explicit_dimension', 'graphic_scale', 'printed_scale', 'known_reference'].map(type => <option key={type} value={type}>{type.replaceAll('_', ' ')}</option>)}</select></label>
          <label className="block text-xs">Physical length shown or separately verified<div className="flex gap-2"><input className={fieldClass} inputMode="decimal" value={reference.drawingLength} placeholder="Enter evidence value" onChange={event => changeReference(index, { drawingLength: event.target.value, independenceVerified: false })} /><select aria-label={`Reference ${index + 1} length unit`} className="rounded border p-2" value={reference.unit} onChange={event => changeReference(index, { unit: event.target.value as typeof reference.unit, independenceVerified: false })}>{['ft', 'm', 'in'].map(unit => <option key={unit}>{unit}</option>)}</select></div></label>
          <label className="block text-xs">Exact visible dimension / evidence<textarea className={fieldClass} value={reference.sourceExcerpt} maxLength={1200} onChange={event => changeReference(index, { sourceExcerpt: event.target.value, independenceVerified: false })} /></label>
          <label className="flex gap-2 text-xs"><input type="checkbox" checked={reference.independenceVerified} onChange={event => changeReference(index, { independenceVerified: event.target.checked })} />This is distinct evidence, checked independently in this same region.</label>
        </div>)}</div>}
        {!count && <p className="text-xs text-amber-800">Use two independently checked sources that agree on scale. Typical door sizes, model consensus and a printed scale by itself do not establish verified measurements.</p>}
        <div className="space-y-2">{(['geometryReviewed', 'identityReviewed', 'duplicateReviewComplete'] as const).map((name, index) => <label key={name} className="flex gap-2 text-xs"><input type="checkbox" checked={draft[name]} onChange={event => changeDraft({ [name]: event.target.checked })} />{['I reviewed the actual traced geometry / visible count.', 'I identified this distinct physical element.', 'I checked duplicates across regions and sheets.'][index]}</label>)}</div>
        <label className="block text-xs">Unresolved ambiguities (one per line)<textarea className={fieldClass} value={draft.uncertainty} maxLength={4800} onChange={event => changeDraft({ uncertainty: event.target.value })} /></label>
        <label className="block text-xs">Review decision<select className={fieldClass} value={draft.decision} onChange={event => changeDraft({ decision: event.target.value as PlanMeasurementDraft['decision'] })}><option value="candidate">Candidate — quantity undetermined</option><option value="blocked">Blocked — evidence pending</option><option value="accepted">Accept reviewed element — server computes quantity</option><option value="rejected">Reject this candidate</option></select></label>
        <button type="submit" className="rounded bg-blue-700 px-4 py-2 text-xs font-semibold text-white disabled:opacity-40">{busy === 'save' ? 'Saving review…' : 'Save measurement review'}</button>
      </fieldset>
    </form>
    {!canWrite && <p className="text-xs text-slate-600">Measurement writes require estimator/admin access and project consent.</p>}
    <div className="space-y-2"><h4 className="text-xs font-semibold">Saved measurements on this physical sheet ({rows.length})</h4>
      {rows.length === 0 && <p className="text-xs text-slate-600">No reviewed elements saved. Quantities and prices remain undetermined.</p>}
      {rows.map(row => <div key={row.id} className="flex flex-wrap justify-between gap-3 rounded border p-3 text-xs"><div><strong>{row.label}</strong><p>{row.review_status} · {row.quantity === null ? 'Quantity undetermined' : `${row.quantity.toLocaleString()} ${row.unit ?? ''}`} · price pending</p><details className="text-slate-500"><summary className="cursor-pointer">Advanced source tracking</summary><p>{row.canonical_trade} / {row.canonical_element_key} · revision {row.review_revision} · calibration {row.calibration?.verificationStatus ?? 'not applicable / pending'}</p></details></div><button type="button" className={buttonClass} disabled={!!busy || needsReload} onClick={() => { setDraft(draftFromSavedPlanMeasurement(row)); setMode(null); setPendingRegionPoint(null); setError(null); setNotice(null); }}>View / review evidence</button></div>)}
      {nextOffset !== null && <button type="button" className={buttonClass} disabled={!!busy} onClick={() => void handleReload(true)}>Load more saved measurements</button>}
    </div>
  </section>;
};
