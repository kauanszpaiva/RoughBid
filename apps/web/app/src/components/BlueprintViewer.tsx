import React, { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { ChevronLeft, ChevronRight, FileText, Maximize2, MapPin, X, ZoomIn, ZoomOut } from "lucide-react";
import type { PlanAnnotation, PlanRevision } from "../types";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface BlueprintViewerProps {
  canWrite?: boolean;
  currentRevision: PlanRevision;
  projectName: string;
  previewUrl?: string | null;
  isPreviewLoading?: boolean;
  previewError?: string | null;
  onAnnotationsChange: (annotations: PlanAnnotation[]) => void;
}

export const BlueprintViewer: React.FC<BlueprintViewerProps> = ({ currentRevision, projectName, previewUrl, isPreviewLoading = false, previewError, onAnnotationsChange, canWrite = false }) => {
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
  const annotations = currentRevision.annotations ?? [];
  const pageAnnotations = annotations.filter(note => note.page === pageNumber);
  const selectedNote = pageAnnotations.find(note => note.id === selectedId);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setAvailableWidth(Math.max(180, element.clientWidth - 32)));
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
    setPageNumber(page); setPendingPoint(null); setSelectedId(null); setAddingNote(false);
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
    <section className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden" aria-label={`${projectName} PDF preview`}>
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
      <div ref={containerRef} className="h-[68dvh] min-h-[360px] max-h-[760px] overflow-auto bg-slate-200/70 p-4 relative">
        {(renderStatus !== 'ready' || !previewUrl) && <div role="status" className="sticky top-0 z-20 p-4 rounded-xl bg-white text-sm text-slate-600 shadow-sm">{error || (isPreviewLoading ? 'Opening your saved PDF…' : previewUrl ? 'Rendering uploaded PDF…' : 'Upload a PDF to preview your plan.')}</div>}
        <div onClick={placeNote} style={{ width: pageSize.width, height: pageSize.height, display: renderStatus === 'ready' ? 'block' : 'none' }} className={`relative mx-auto bg-white shadow-lg shrink-0 ${addingNote ? 'cursor-crosshair' : ''}`}>
          <canvas ref={canvasRef} aria-label={`Uploaded PDF: ${currentRevision.fileName}, page ${pageNumber}`} style={{ width: '100%', height: '100%' }} />
          {pageAnnotations.map((note, index) => <button key={note.id} type="button" aria-label={`Plan note ${index + 1}: ${note.text}`} title={note.text} onClick={event => { event.stopPropagation(); setSelectedId(note.id); setPendingPoint(null); }} style={{ left: `${note.x * 100}%`, top: `${note.y * 100}%` }} className={`absolute -translate-x-1/2 -translate-y-1/2 size-8 rounded-full border-2 border-white shadow-md text-white text-xs font-bold ${selectedId === note.id ? 'bg-blue-800 ring-2 ring-blue-300' : 'bg-blue-600'}`}>{index + 1}</button>)}
          {pendingPoint && <span style={{ left: `${pendingPoint.x * 100}%`, top: `${pendingPoint.y * 100}%` }} className="absolute -translate-x-1/2 -translate-y-1/2 size-5 bg-blue-500/60 ring-4 ring-blue-200 rounded-full" />}
        </div>
      </div>
      {pendingPoint && <form onSubmit={saveNote} className="p-4 border-t border-blue-200 bg-blue-50 space-y-2">
        <label htmlFor="plan-note" className="text-xs font-bold text-blue-950">Your note · page {pageNumber}</label>
        <textarea id="plan-note" autoFocus maxLength={500} value={noteText} onChange={event => setNoteText(event.target.value)} placeholder="What needs checking at this location?" className="block w-full p-3 text-sm border border-blue-200 bg-white rounded-lg" />
        <div className="flex justify-end gap-2"><button type="button" onClick={() => setPendingPoint(null)} className="px-3 py-2 text-xs">Cancel</button><button type="submit" disabled={!noteText.trim()} className="px-3 py-2 bg-blue-600 text-white rounded-lg text-xs font-semibold disabled:opacity-40">Save note</button></div>
      </form>}
      {selectedNote && <div className="p-4 border-t border-blue-200 bg-blue-50 flex justify-between items-start gap-3"><div><p className="text-[10px] font-bold text-blue-700 uppercase tracking-wider">Your plan note · page {pageNumber}</p><p className="text-sm text-slate-800 mt-1 whitespace-pre-wrap break-words">{selectedNote.text}</p></div><button type="button" aria-label="Close plan note" onClick={() => setSelectedId(null)} className="p-1"><X className="size-4" /></button></div>}
      <p className="px-4 py-3 border-t border-slate-200 text-[11px] text-slate-500">Original PDF · {pageAnnotations.length} saved notes on this page. Notes mark your review locations; they do not measure or interpret the drawing.</p>
    </section>
  );
};
