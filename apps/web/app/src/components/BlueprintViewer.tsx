import React, { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PlanRevision } from '../types';
import { createDocumentDownloadUrl } from '../services/api';

GlobalWorkerOptions.workerSrc = workerUrl;

export function BlueprintViewer({ currentRevision, projectName, workspaceId }: { currentRevision: PlanRevision; projectName: string; workspaceId?: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [width, setWidth] = useState(600);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => setWidth(entries[0]?.contentRect.width ?? 600));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof getDocument> | undefined;
    const controller = new AbortController();
    setPdf(null); setPage(1); setError(''); setLoading(true);
    void (async () => {
      try {
        let url = currentRevision.fileUrl;
        let headers: Record<string, string> = {};
        if (!url && workspaceId && currentRevision.remoteFileId) {
          const signed = await createDocumentDownloadUrl(workspaceId, currentRevision.remoteFileId!);
          url = signed.url; headers = signed.headers;
        }
        if (!url) throw Error('Upload a PDF to view its pages.');
        const response = await fetch(url, { headers, signal: controller.signal });
        if (!response.ok) throw Error(`Could not load the private PDF (${response.status}).`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (cancelled) return;
        task = getDocument({ data: bytes, useSystemFonts: true,
          cMapUrl: '/app/pdfjs/cmaps/', cMapPacked: true,
          standardFontDataUrl: '/app/pdfjs/standard_fonts/', wasmUrl: '/app/pdfjs/wasm/' });
        const document = await task.promise;
        if (!cancelled) setPdf(document);
      } catch (e) { if (!cancelled) { setError(e instanceof Error ? e.message : 'Could not load the PDF.'); setLoading(false); } }
    })();
    return () => { cancelled = true; controller.abort(); void task?.destroy(); };
  }, [currentRevision.fileUrl, currentRevision.remoteFileId, workspaceId]);

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    let rendering: RenderTask | undefined;
    setLoading(true); setError('');
    void (async () => {
      try {
        const documentPage = await pdf.getPage(page);
        if (cancelled || !canvasRef.current) return;
        const canvas = canvasRef.current;
        const base = documentPage.getViewport({ scale: 1 });
        const scale = Math.max(100, width - 32) / base.width * zoom / 100;
        const viewport = documentPage.getViewport({ scale });
        const pixels = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * pixels);
        canvas.height = Math.floor(viewport.height * pixels);
        canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
        rendering = documentPage.render({ canvas, viewport, transform: [pixels, 0, 0, pixels, 0, 0] });
        await rendering.promise;
        if (!cancelled) setLoading(false);
      } catch (e) { if (!cancelled) { setError(e instanceof Error ? e.message : 'Could not render this page.'); setLoading(false); } }
    })();
    return () => { cancelled = true; rendering?.cancel(); };
  }, [pdf, page, zoom, width]);

  return <section aria-label={`${projectName} PDF preview`} className="border border-slate-200 rounded-xl bg-white overflow-hidden flex flex-col h-[68dvh] min-h-[430px]">
    <div className="flex flex-wrap items-center gap-2 border-b p-3 text-sm">
      <span className="font-semibold truncate max-w-48" title={currentRevision.fileName}>{currentRevision.fileName}</span>
      <button className="rounded border px-2 py-1 disabled:opacity-40" disabled={!pdf || page <= 1} onClick={() => setPage(p => p - 1)} aria-label="Previous PDF page">Previous</button>
      <span>Page {page} of {pdf?.numPages ?? currentRevision.pages}</span>
      <button className="rounded border px-2 py-1 disabled:opacity-40" disabled={!pdf || page >= pdf.numPages} onClick={() => setPage(p => p + 1)} aria-label="Next PDF page">Next</button>
      <button className="rounded border px-2 py-1" aria-label="Zoom out" onClick={() => setZoom(z => Math.max(50, z - 25))}>−</button>
      <span>{zoom}%</span>
      <button className="rounded border px-2 py-1" aria-label="Zoom in" onClick={() => setZoom(z => Math.min(250, z + 25))}>+</button>
      <button className="rounded border px-2 py-1" onClick={() => setZoom(100)}>Fit width</button>
    </div>
    {loading && <p role="status" className="px-4 py-2 text-sm text-slate-600">Loading PDF page…</p>}
    {error && <p role="alert" className="p-4 text-sm text-red-700">{error}</p>}
    <div ref={containerRef} className="flex-1 overflow-auto bg-slate-100 p-4">
      <canvas ref={canvasRef} role="img" aria-label={`Uploaded PDF: ${currentRevision.fileName}, page ${page}`} className="mx-auto bg-white shadow-sm" />
    </div>
    <p className="border-t px-3 py-2 text-xs text-slate-500">Original PDF page. Compare it with the evidence in Plan findings before accepting quantities.</p>
  </section>;
}
