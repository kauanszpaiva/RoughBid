import React, { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { AlertCircle, Bot, ChevronLeft, ChevronRight, FileText, Layers, MapPin, Maximize2, Sparkles, X, ZoomIn, ZoomOut } from "lucide-react";
import type { PlanAnnotation, PlanRevision } from "../types";
import type { PlanReadingFinding } from "../services/api";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface BlueprintViewerProps {
  canWrite?: boolean;
  findings?: PlanReadingFinding[];
  currentRevision: PlanRevision;
  projectName: string;
  previewUrl?: string | null;
  isPreviewLoading?: boolean;
  previewError?: string | null;
  onAnnotationsChange: (annotations: PlanAnnotation[]) => void;
}

export const BlueprintViewer: React.FC<BlueprintViewerProps> = ({ currentRevision, projectName, previewUrl, isPreviewLoading = false, previewError, onAnnotationsChange, canWrite = false, findings = [] }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [availableWidth, setAvailableWidth] = useState(600);
  const [pageSize, setPageSize] = useState({ width: 600, height: 780 });
  const [renderStatus, setRenderStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [renderError, setRenderError] = useState<string | null>(null);
  const [addingNote, setAddingNote] = useState(false);
  const [pendingPoint, setPendingPoint] = useState<{ x: number; y: number } | null>(null);
  const [noteText, setNoteText] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [findingFilter, setFindingFilter] = useState('all');
  const [showAreas, setShowAreas] = useState(true);
  const [showAIMarkers, setShowAIMarkers] = useState(true);
  const [activeTab, setActiveTab] = useState<'canvas' | 'report'>('canvas');
  const [search, setSearch] = useState('');
  const reviewFindings = findings.filter(f => f.status !== 'rejected');
  const visibleFindings = reviewFindings.filter(f => (findingFilter === 'all' || f.finding_type === findingFilter) && `${f.label} ${f.source_excerpt ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  const selectedFinding = reviewFindings.find(f => f.id === selectedFindingId);

  const boxFor = (finding: PlanReadingFinding): [number, number, number, number] | null => {
    const box = finding.geometry?.bbox;
    if (!Array.isArray(box) || box.length !== 4 || !box.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) return null;
    const [x, y, width, height] = box as number[];
    return width! > 0 && height! > 0 && x! + width! <= 1 && y! + height! <= 1 ? box as [number, number, number, number] : null;
  };

  const pointFor = (finding: PlanReadingFinding): { x: number; y: number } | null => {
    const box = boxFor(finding);
    if (box) {
      return { x: box[0] + box[2] / 2, y: box[1] + box[3] / 2 };
    }
    const pt = finding.geometry?.point;
    if (Array.isArray(pt) && pt.length === 2 && typeof pt[0] === 'number' && typeof pt[1] === 'number' && pt[0] >= 0 && pt[0] <= 1 && pt[1] >= 0 && pt[1] <= 1) {
      return { x: pt[0], y: pt[1] };
    }
    return null;
  };

  const getAreaName = (finding: PlanReadingFinding): string => {
    if (typeof finding.geometry?.area === 'string' && finding.geometry.area.trim()) return finding.geometry.area.trim();
    if (typeof finding.geometry?.room === 'string' && finding.geometry.room.trim()) return finding.geometry.room.trim();
    if (finding.finding_type === 'room' && finding.label.trim()) return finding.label.trim();
    return 'Unknown Area';
  };

  const areaGroups = React.useMemo(() => {
    const map = new Map<string, {
      areaName: string;
      findings: PlanReadingFinding[];
      pages: Set<number>;
      materialCost: number;
      laborCost: number;
      unpricedCount: number;
    }>();

    for (const finding of reviewFindings) {
      const area = getAreaName(finding);
      if (!map.has(area)) {
        map.set(area, { areaName: area, findings: [], pages: new Set(), materialCost: 0, laborCost: 0, unpricedCount: 0 });
      }
      const group = map.get(area)!;
      group.findings.push(finding);
      if (finding.page_number) group.pages.add(finding.page_number);

      const pricing = (finding.geometry as { pricing?: Array<{ category: 'material' | 'labor'; cost: number }> })?.pricing;
      if (Array.isArray(pricing) && pricing.length > 0) {
        for (const item of pricing) {
          if (item.category === 'material') group.materialCost += item.cost;
          if (item.category === 'labor') group.laborCost += item.cost;
        }
      } else if (finding.quantity !== null && finding.quantity > 0) {
        group.unpricedCount += 1;
      }
    }
    return Array.from(map.values()).sort((a, b) => a.areaName.localeCompare(b.areaName));
  }, [reviewFindings]);
  const focusFinding = (finding: PlanReadingFinding) => {
    if (pdf && finding.page_number && finding.page_number <= pdf.numPages) {
      setPageNumber(finding.page_number); setSelectedFindingId(finding.id); setPendingPoint(null); setAddingNote(false);
      containerRef.current?.scrollTo(0, 0);
    }
  };
  const annotations = currentRevision.annotations ?? [];
  const pageAnnotations = annotations.filter(note => note.page === pageNumber);
  const selectedNote = pageAnnotations.find(note => note.id === selectedId);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const updateWidth = () => {
      const measuredWidth = element.clientWidth;
      const effectiveWidth = measuredWidth > 0 ? measuredWidth : 632;
      setAvailableWidth(Math.max(180, effectiveWidth - 32));
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let canceled = false;
    const controller = new AbortController();
    let loadingTask: ReturnType<typeof pdfjs.getDocument> | undefined;
    setPdf(null); setPageNumber(1); setZoom(100); setRenderStatus('loading'); setRenderError(null);
    setPendingPoint(null); setSelectedId(null); setAddingNote(false);
    if (!previewUrl) return () => controller.abort();
    void (async () => {
      try {
        const response = await fetch(previewUrl, { signal: controller.signal });
        if (!response.ok) throw new Error(`Unable to open this PDF (${response.status}).`);
        const data = await response.arrayBuffer();
        if (canceled) return;
        loadingTask = pdfjs.getDocument({ data });
        const document = await loadingTask.promise;
        if (!canceled) setPdf(document);
      } catch (error) {
        if (!canceled) { setRenderStatus('failed'); setRenderError(error instanceof Error ? error.message : 'Unable to open this PDF.'); }
      }
    })();
    return () => { canceled = true; controller.abort(); void loadingTask?.destroy(); };
  }, [previewUrl]);

  useEffect(() => {
    if (!pdf) return;
    let canceled = false;
    let task: ReturnType<pdfjs.PDFPageProxy['render']> | undefined;
    setRenderStatus('loading'); setRenderError(null);
    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (canceled || !canvasRef.current) return;
        const base = page.getViewport({ scale: 1 });
        const scale = availableWidth / base.width * zoom / 100;
        const viewport = page.getViewport({ scale });
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        // Render into a detached canvas, so an old page cannot overwrite a newer one.
        const staging = document.createElement('canvas');
        staging.width = Math.ceil(viewport.width * pixelRatio);
        staging.height = Math.ceil(viewport.height * pixelRatio);
        const context = staging.getContext('2d');
        if (!context) throw new Error('PDF preview is unavailable in this browser.');
        task = page.render({ canvas: staging, canvasContext: context, viewport, transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] });
        await task.promise;
        if (canceled || !canvasRef.current) return;
        const canvas = canvasRef.current;
        canvas.width = staging.width; canvas.height = staging.height;
        canvas.getContext('2d')?.drawImage(staging, 0, 0);
        setPageSize({ width: viewport.width, height: viewport.height });
        setRenderStatus('ready');
      } catch (error) {
        if (!canceled) { setRenderStatus('failed'); setRenderError(error instanceof Error ? error.message : 'Unable to draw this page.'); }
      }
    })();
    return () => { canceled = true; task?.cancel(); };
  }, [pdf, pageNumber, availableWidth, zoom]);

  const changePage = (page: number) => {
    setPageNumber(page); setPendingPoint(null); setSelectedId(null); setSelectedFindingId(null); setAddingNote(false);
    containerRef.current?.scrollTo(0, 0);
  };
  const placeNote = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!canWrite || !addingNote || renderStatus !== 'ready') return;
    const bounds = event.currentTarget.getBoundingClientRect();
    setPendingPoint({ x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) });
    setNoteText(''); setSelectedId(null); setAddingNote(false);
  };
  const saveNote = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canWrite || !pendingPoint || !noteText.trim()) return;
    const note = { id: crypto.randomUUID(), page: pageNumber, ...pendingPoint, text: noteText.trim().slice(0, 500) };
    onAnnotationsChange([...annotations, note]); setSelectedId(note.id); setPendingPoint(null);
  };
  const error = previewError || renderError;

  return (
    <section className="bg-white border border-slate-200 rounded-lg overflow-hidden" aria-label={`${projectName} PDF preview`}>
      <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap gap-3 items-center justify-between">
        <div className="flex items-center gap-2 min-w-0 flex-1"><FileText className="size-4 text-blue-600 shrink-0" /><span className="truncate text-xs font-semibold" title={currentRevision.fileName}>{currentRevision.fileName}</span></div>
        <span className="text-[10px] font-bold text-blue-700 bg-blue-50 rounded px-2 py-1">REV {currentRevision.revisionNumber}</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-slate-50 border-b border-slate-200 text-xs">
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Previous PDF page" disabled={!pdf || pageNumber <= 1} onClick={() => changePage(pageNumber - 1)} className="p-2 rounded hover:bg-slate-200 disabled:opacity-30"><ChevronLeft className="size-4" /></button>
          <label className="flex gap-1 items-center">Page <select aria-label="PDF page" value={pageNumber} disabled={!pdf} onChange={event => changePage(Number(event.target.value))} className="rounded border border-slate-200 bg-white p-1">{Array.from({ length: pdf?.numPages ?? 1 }, (_, i) => <option key={i + 1}>{i + 1}</option>)}</select><span className="text-slate-500">of {pdf?.numPages ?? currentRevision.pages ?? 0}</span></label>
          <button type="button" aria-label="Next PDF page" disabled={!pdf || pageNumber >= pdf.numPages} onClick={() => changePage(pageNumber + 1)} className="p-2 rounded hover:bg-slate-200 disabled:opacity-30"><ChevronRight className="size-4" /></button>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Zoom out" disabled={zoom <= 50} onClick={() => setZoom(value => Math.max(50, value - 25))} className="p-2 rounded hover:bg-slate-200 disabled:opacity-30"><ZoomOut className="size-4" /></button>
          <span className="w-10 text-center tabular-nums">{zoom}%</span>
          <button type="button" aria-label="Zoom in" disabled={zoom >= 250} onClick={() => setZoom(value => Math.min(250, value + 25))} className="p-2 rounded hover:bg-slate-200 disabled:opacity-30"><ZoomIn className="size-4" /></button>
          <button type="button" aria-label="Fit width" onClick={() => setZoom(100)} className="p-2 rounded hover:bg-slate-200"><Maximize2 className="size-4" /></button>
        </div>
        <button type="button" disabled={!canWrite || renderStatus !== 'ready'} aria-pressed={addingNote} onClick={() => { setAddingNote(!addingNote); setPendingPoint(null); }} className={`flex items-center gap-1.5 rounded-lg px-3 py-2 font-semibold disabled:opacity-40 ${addingNote ? 'bg-blue-700 text-white' : 'bg-blue-50 text-blue-700 hover:bg-blue-100'}`}><MapPin className="size-4" />{addingNote ? 'Tap the plan' : 'Add note'}</button>
      </div>
      {findings.length > 0 && <div className="p-3 border-b border-slate-200 space-y-3" aria-label="Plan areas and findings">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2">
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={() => setActiveTab('canvas')} className={`px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5 ${activeTab === 'canvas' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}><FileText className="size-3.5" /> Plan Canvas</button>
            <button type="button" onClick={() => setActiveTab('report')} className={`px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5 ${activeTab === 'report' ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}><Layers className="size-3.5" /> Area Takeoff Report</button>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <label className="flex gap-1.5 items-center cursor-pointer"><input type="checkbox" checked={showAreas} onChange={e => setShowAreas(e.target.checked)} />Bounding Boxes</label>
            <label className="flex gap-1.5 items-center cursor-pointer"><input type="checkbox" checked={showAIMarkers} onChange={e => setShowAIMarkers(e.target.checked)} /><Sparkles className="size-3 text-emerald-600" /> AI Markers</label>
          </div>
        </div>

        {activeTab === 'canvas' ? (
          <>
            <div className="flex flex-wrap gap-2">
              <input aria-label="Search plan findings" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search rooms, materials, notes..." className="min-w-0 flex-1 border rounded-lg p-2 text-xs" />
              <select aria-label="Finding type" value={findingFilter} onChange={e => setFindingFilter(e.target.value)} className="border rounded-lg p-2 text-xs bg-white">
                <option value="all">All findings</option>
                <option value="room">Rooms & areas</option>
                <option value="measurement">Measurements</option>
                <option value="material">Materials</option>
                <option value="labor">Labor scope</option>
                <option value="risk">Risks</option>
                <option value="question">Questions</option>
                <option value="scope_note">Scope notes</option>
                <option value="symbol">Symbols</option>
              </select>
            </div>
            <div className="max-h-40 overflow-y-auto divide-y divide-slate-100 rounded-lg border border-slate-100 bg-white">
              {visibleFindings.map(finding => {
                const pt = pointFor(finding);
                return (
                  <button type="button" key={finding.id} onClick={() => focusFinding(finding)} disabled={!pdf || !finding.page_number || finding.page_number > pdf.numPages} aria-pressed={selectedFindingId === finding.id} className={`w-full text-left py-2 px-2.5 text-xs flex justify-between gap-3 disabled:opacity-50 ${selectedFindingId === finding.id ? 'bg-emerald-50 text-emerald-900 font-medium' : 'hover:bg-slate-50'}`}>
                    <span className="min-w-0 break-words">
                      <strong className="text-slate-900">{finding.label}</strong>
                      <span className="block text-[#6b7280]">
                        {getAreaName(finding)} · {finding.finding_type.replace('_', ' ')} · {Math.round(finding.confidence * 100)}% confidence{!pt ? ' · Unmapped page note' : ''}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="font-semibold text-slate-800">{finding.quantity !== null ? `${finding.quantity} ${finding.unit ?? ''}` : 'Review'}</span>
                      <span className="block text-[#6b7280]">Sheet {finding.page_number ?? '?'}</span>
                    </span>
                  </button>
                );
              })}
              {!visibleFindings.length && <p className="text-xs text-slate-500 py-3 text-center">No matching findings.</p>}
            </div>
          </>
        ) : (
          <div className="space-y-3" aria-label="Area Takeoff Grouping Report">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="bg-emerald-50 border border-emerald-200 p-2.5 rounded-lg text-emerald-900">
                <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">Total Material Cost</p>
                <strong className="text-base font-semibold">
                  {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(areaGroups.reduce((acc, g) => acc + g.materialCost, 0))}
                </strong>
              </div>
              <div className="bg-blue-50 border border-blue-200 p-2.5 rounded-lg text-blue-900">
                <p className="text-[10px] font-bold uppercase tracking-wider text-blue-700">Total Labor Cost</p>
                <strong className="text-base font-semibold">
                  {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(areaGroups.reduce((acc, g) => acc + g.laborCost, 0))}
                </strong>
              </div>
              <div className="bg-amber-50 border border-amber-200 p-2.5 rounded-lg text-amber-900">
                <p className="text-[10px] font-bold uppercase tracking-wider text-amber-700">Unpriced Takeoffs</p>
                <strong className="text-base font-semibold">{areaGroups.reduce((acc, g) => acc + g.unpricedCount, 0)} items</strong>
              </div>
            </div>

            <div className="max-h-56 overflow-y-auto space-y-2">
              {areaGroups.map(group => (
                <div key={group.areaName} className="border border-slate-200 rounded-lg p-3 bg-white space-y-2">
                  <div className="flex flex-wrap justify-between items-center gap-2 border-b border-slate-100 pb-2">
                    <div>
                      <strong className="text-xs text-slate-900">{group.areaName}</strong>
                      <span className="text-[10px] text-slate-500 block">Sheets: {Array.from(group.pages).sort().join(', ') || 'N/A'} · {group.findings.length} findings</span>
                    </div>
                    <div className="text-right text-xs">
                      <span className="text-emerald-700 font-semibold mr-3">Mat: ${group.materialCost.toFixed(2)}</span>
                      <span className="text-blue-700 font-semibold">Labor: ${group.laborCost.toFixed(2)}</span>
                    </div>
                  </div>
                  <div className="space-y-1">
                    {group.findings.map(f => (
                      <div key={f.id} onClick={() => { setActiveTab('canvas'); focusFinding(f); }} className="text-[11px] flex justify-between items-center p-1.5 hover:bg-slate-50 rounded cursor-pointer">
                        <span className="truncate flex items-center gap-1">
                          <Bot className="size-3 text-emerald-600 shrink-0" />
                          <span className="font-medium text-slate-800">{f.label}</span>
                          <span className="text-slate-400">({f.finding_type})</span>
                        </span>
                        <span className="font-semibold text-slate-700 shrink-0">{f.quantity !== null ? `${f.quantity} ${f.unit ?? ''}` : 'Review'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>}
      <div ref={containerRef} style={{ scrollbarGutter: 'stable' }} className="h-[68dvh] min-h-[360px] max-h-[760px] overflow-auto bg-slate-200/70 p-4 relative">
        {(renderStatus !== 'ready' || !previewUrl) && <div role="status" className="sticky top-0 z-20 p-4 rounded-xl bg-white text-sm text-slate-600 shadow-sm">{error || (isPreviewLoading ? 'Opening your saved PDF…' : previewUrl ? 'Rendering uploaded PDF…' : 'Upload a PDF to preview your plan.')}</div>}
        <div onClick={placeNote} style={{ width: pageSize.width, height: pageSize.height, display: renderStatus === 'ready' ? 'block' : 'none' }} className={`relative mx-auto bg-white shadow-lg shrink-0 ${addingNote ? 'cursor-crosshair' : ''}`}>
          <canvas ref={canvasRef} aria-label={`Uploaded PDF: ${currentRevision.fileName}, page ${pageNumber}`} style={{ width: '100%', height: '100%' }} />

          {/* AI Bounding Box Areas */}
          {showAreas && visibleFindings.filter(f => f.page_number === pageNumber).map(finding => {
            const box = boxFor(finding);
            if (!box) return null;
            return <button type="button" key={`box-${finding.id}`} title={`${finding.label} - click to review evidence`} aria-label={`Highlight area ${finding.label}`} onClick={event => { event.stopPropagation(); focusFinding(finding); }} style={{ left: `${box[0]! * 100}%`, top: `${box[1]! * 100}%`, width: `${box[2]! * 100}%`, height: `${box[3]! * 100}%`, pointerEvents: addingNote ? 'none' : 'auto' }} className={`absolute border-2 ${selectedFindingId === finding.id ? 'border-emerald-700 bg-emerald-400/30 ring-2 ring-white z-10' : finding.finding_type === 'risk' ? 'border-amber-600 bg-amber-300/15 hover:bg-amber-300/25' : 'border-emerald-500 bg-emerald-300/10 hover:bg-emerald-300/20'}`} />;
          })}

          {/* AI Finding Markers - ONLY rendered when valid source geometry is present */}
          {showAIMarkers && visibleFindings.filter(f => f.page_number === pageNumber).map((finding) => {
            const pt = pointFor(finding);
            if (!pt) return null;
            const isSelected = selectedFindingId === finding.id;
            return (
              <button
                key={`marker-${finding.id}`}
                type="button"
                aria-label={`AI marker: ${finding.label}`}
                title={`AI Finding: ${finding.label} (${finding.finding_type})`}
                onClick={event => { event.stopPropagation(); focusFinding(finding); }}
                style={{ left: `${pt.x * 100}%`, top: `${pt.y * 100}%` }}
                className={`absolute -translate-x-1/2 -translate-y-1/2 size-7 rounded-full border-2 border-white shadow-md text-white text-[10px] font-bold flex items-center justify-center transition-all ${
                  isSelected ? 'bg-emerald-800 ring-4 ring-emerald-300 scale-110 z-20' : finding.finding_type === 'risk' ? 'bg-amber-600 hover:scale-105 z-10' : 'bg-emerald-600 hover:scale-105 z-10'
                }`}
              >
                <Bot className="size-3.5" />
              </button>
            );
          })}

          {/* MANUAL Annotation Markers - Blue Numbered Circles */}
          {pageAnnotations.map((note, index) => <button key={note.id} type="button" aria-label={`Manual plan note ${index + 1}: ${note.text}`} title={note.text} onClick={event => { event.stopPropagation(); setSelectedId(note.id); setSelectedFindingId(null); setPendingPoint(null); }} style={{ left: `${note.x * 100}%`, top: `${note.y * 100}%` }} className={`absolute -translate-x-1/2 -translate-y-1/2 size-8 rounded-full border-2 border-white shadow-md text-white text-xs font-bold flex items-center justify-center ${selectedId === note.id ? 'bg-blue-800 ring-2 ring-blue-300 z-20' : 'bg-blue-600 hover:bg-blue-700 z-10'}`}>{index + 1}</button>)}
          {pendingPoint && <span style={{ left: `${pendingPoint.x * 100}%`, top: `${pendingPoint.y * 100}%` }} className="absolute -translate-x-1/2 -translate-y-1/2 size-5 bg-blue-500/60 ring-4 ring-blue-200 rounded-full" />}
        </div>

        {/* Page-level Unmapped Notes Indicator for findings on this sheet lacking geometry */}
        {visibleFindings.filter(f => f.page_number === pageNumber && !pointFor(f)).length > 0 && (
          <div className="sticky bottom-2 mx-auto max-w-md bg-slate-900/90 text-white rounded-lg p-2.5 shadow-lg backdrop-blur text-xs flex items-center justify-between gap-2 z-20">
            <div className="flex items-center gap-2 min-w-0">
              <AlertCircle className="size-4 text-amber-400 shrink-0" />
              <span className="truncate">
                {visibleFindings.filter(f => f.page_number === pageNumber && !pointFor(f)).length} unmapped findings on Sheet {pageNumber} (no canvas point)
              </span>
            </div>
            <button type="button" onClick={() => setActiveTab('canvas')} className="px-2 py-1 bg-white/20 hover:bg-white/30 rounded text-[10px] font-semibold shrink-0">Review list</button>
          </div>
        )}
      </div>

      {/* Selected Finding Evidence Callout */}
      {selectedFinding && <div className="p-4 border-t border-emerald-200 bg-emerald-50/90 text-sm space-y-2" aria-label="Selected plan finding evidence"><div className="flex items-start justify-between gap-3"><div><h4 className="font-bold text-slate-900 flex items-center gap-2"><Bot className="size-4 text-emerald-700" /><span>{selectedFinding.label}</span><span className="text-[10px] uppercase font-mono px-1.5 py-0.5 bg-emerald-100 text-emerald-800 rounded">{selectedFinding.finding_type}</span></h4><p className="text-xs text-slate-600 mt-0.5">Finding ID: <code className="font-mono">{selectedFinding.id}</code> · Sheet {selectedFinding.page_number ?? '?'} · Area: {getAreaName(selectedFinding)}</p></div><button type="button" aria-label="Close finding details" onClick={() => setSelectedFindingId(null)}><X className="size-4 text-slate-600 hover:text-slate-900" /></button></div><p className="text-xs text-emerald-950 bg-white/80 p-2.5 rounded border border-emerald-200 whitespace-pre-wrap break-words">{selectedFinding.source_excerpt || 'No source excerpt available from plan.'}</p><div className="flex flex-wrap items-center justify-between text-xs text-slate-700 pt-1"><span>Confidence: <strong>{Math.round(selectedFinding.confidence * 100)}%</strong> · Status: <strong className="capitalize">{selectedFinding.status.replace('_', ' ')}</strong></span><span>{selectedFinding.quantity !== null ? `Quantity: ${selectedFinding.quantity} ${selectedFinding.unit ?? ''}` : selectedFinding.value_text || 'Review required'}</span></div></div>}

      {pendingPoint && <form onSubmit={saveNote} className="p-4 border-t border-blue-200 bg-blue-50 space-y-2">
        <label htmlFor="plan-note" className="text-xs font-bold text-blue-950">Your manual note · sheet {pageNumber}</label>
        <textarea id="plan-note" autoFocus maxLength={500} value={noteText} onChange={event => setNoteText(event.target.value)} placeholder="What needs checking at this location?" className="block w-full p-3 text-sm border border-blue-200 bg-white rounded-lg" />
        <div className="flex justify-end gap-2"><button type="button" onClick={() => setPendingPoint(null)} className="px-3 py-2 text-xs">Cancel</button><button type="submit" disabled={!noteText.trim()} className="px-3 py-2 bg-blue-600 text-white rounded-lg text-xs font-semibold disabled:opacity-40">Save note</button></div>
      </form>}
      {selectedNote && <div className="p-4 border-t border-blue-200 bg-blue-50 flex justify-between items-start gap-3"><div><p className="text-[10px] font-bold text-blue-700 uppercase tracking-wider">Your manual plan note · sheet {pageNumber}</p><p className="text-sm text-slate-800 mt-1 whitespace-pre-wrap break-words">{selectedNote.text}</p></div><button type="button" aria-label="Close plan note" onClick={() => setSelectedId(null)} className="p-1"><X className="size-4" /></button></div>}
      <p className="px-4 py-3 border-t border-slate-200 text-[11px] text-slate-500 flex justify-between items-center"><span>Original PDF · {pageAnnotations.length} manual notes saved on this page.</span><span>Numbered blue dots = Manual notes · Green badges = AI markers</span></p>
    </section>
  );
};
