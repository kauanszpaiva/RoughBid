import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist/types/src/display/api';
import type { PlanReadingFinding } from '../../../services/api';
import type { PlanAnnotation } from '../../../types';
import type { NormalizedPoint } from '../types';
import { FindingOverlay } from './FindingOverlay';
import { AnnotationOverlay } from './AnnotationOverlay';

type PageMetrics = { width: number; height: number };

type Props = {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  fileName: string;
  zoomPercent: number;
  findings?: PlanReadingFinding[];
  annotations?: PlanAnnotation[];
  selectedFindingId?: string | null;
  selectedAnnotationId?: string | null;
  showAiMarkers?: boolean;
  showFindingHighlights?: boolean;
  showManualNotes?: boolean;
  pendingNote?: NormalizedPoint | null;
  onSelectFinding?: (findingId: string) => void;
  onSelectAnnotation?: (annotationId: string) => void;
  onPageMetrics?: (pageNumber: number, metrics: PageMetrics) => void;
};

export function BlueprintPage({
  pdf,
  pageNumber,
  fileName,
  zoomPercent,
  findings = [],
  annotations = [],
  selectedFindingId = null,
  selectedAnnotationId = null,
  showAiMarkers = true,
  showFindingHighlights = true,
  showManualNotes = true,
  pendingNote = null,
  onSelectFinding,
  onSelectAnnotation,
  onPageMetrics,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pageSize, setPageSize] = useState<PageMetrics>({ width: 0, height: 0 });
  const [renderStatus, setRenderStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | undefined;
    setRenderStatus('loading');
    setRenderError(null);

    void (async () => {
      try {
        const page: PDFPageProxy = await pdf.getPage(pageNumber);
        if (cancelled || !canvasRef.current) return;
        const base = page.getViewport({ scale: 1 });
        onPageMetrics?.(pageNumber, { width: base.width, height: base.height });
        const viewport = page.getViewport({ scale: Math.max(0.01, zoomPercent / 100) });
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const staging = document.createElement('canvas');
        staging.width = Math.ceil(viewport.width * pixelRatio);
        staging.height = Math.ceil(viewport.height * pixelRatio);
        const context = staging.getContext('2d');
        if (!context) throw new Error('PDF preview is unavailable in this browser.');
        renderTask = page.render({
          canvas: staging,
          canvasContext: context,
          viewport,
          transform: [pixelRatio, 0, 0, pixelRatio, 0, 0],
        });
        await renderTask.promise;
        if (cancelled || !canvasRef.current) return;
        const canvas = canvasRef.current;
        canvas.width = staging.width;
        canvas.height = staging.height;
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        canvas.getContext('2d')?.drawImage(staging, 0, 0);
        setPageSize({ width: viewport.width, height: viewport.height });
        setRenderStatus('ready');
      } catch (error) {
        if (cancelled) return;
        const name = error instanceof Error ? error.name : '';
        if (name === 'RenderingCancelledException') return;
        setRenderStatus('failed');
        setRenderError(error instanceof Error ? error.message : 'Unable to draw this page.');
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdf, pageNumber, zoomPercent, onPageMetrics]);

  return (
    <div
      data-pdf-page={pageNumber}
      data-render-status={renderStatus}
      className="relative bg-white shadow-sm"
      style={pageSize.width > 0 ? { width: `${pageSize.width}px`, height: `${pageSize.height}px` } : undefined}
    >
      <canvas
        ref={canvasRef}
        aria-label={`Uploaded PDF: ${fileName}, page ${pageNumber}`}
        className={`block ${renderStatus === 'ready' ? '' : 'opacity-0'}`}
      />
      {renderStatus === 'loading' && <div role="status" className="absolute inset-0 grid place-items-center text-xs text-slate-500">Rendering page {pageNumber}...</div>}
      {renderStatus === 'failed' && <div role="status" className="min-h-48 grid place-items-center p-4 text-sm text-red-700">{renderError ?? 'Unable to draw this page.'}</div>}
      {renderStatus === 'ready' && (
        <>
          <FindingOverlay
            findings={findings}
            pageNumber={pageNumber}
            selectedFindingId={selectedFindingId}
            showAiMarkers={showAiMarkers}
            showFindingHighlights={showFindingHighlights}
            onSelectFinding={onSelectFinding}
          />
          <AnnotationOverlay
            annotations={annotations}
            pageNumber={pageNumber}
            selectedAnnotationId={selectedAnnotationId}
            showManualNotes={showManualNotes}
            pendingNote={pendingNote}
            onSelectAnnotation={onSelectAnnotation}
          />
        </>
      )}
    </div>
  );
}
