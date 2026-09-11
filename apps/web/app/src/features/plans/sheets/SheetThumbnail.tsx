import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist/types/src/display/api';

type Props = {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  label: string;
  targetWidth?: number;
};

export function SheetThumbnail({ pdf, pageNumber, label, targetWidth = 140 }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [height, setHeight] = useState(Math.round(targetWidth * 0.72));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '240px 0px' });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: RenderTask | undefined;
    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled || !canvasRef.current) return;
        const base = page.getViewport({ scale: 1 });
        const scale = targetWidth / base.width;
        const viewport = page.getViewport({ scale });
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');
        if (!context) return;
        canvas.width = Math.ceil(viewport.width * pixelRatio);
        canvas.height = Math.ceil(viewport.height * pixelRatio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        setHeight(Math.round(viewport.height));
        task = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: [pixelRatio, 0, 0, pixelRatio, 0, 0],
        });
        await task.promise;
      } catch (error) {
        if (cancelled || (error instanceof Error && error.name === 'RenderingCancelledException')) return;
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, pageNumber, targetWidth, visible]);

  return (
    <div ref={hostRef} className="flex w-full items-center justify-center overflow-hidden rounded border border-slate-200 bg-slate-100" style={{ minHeight: `${height}px` }}>
      <canvas ref={canvasRef} aria-label={`Thumbnail for ${label}`} className={visible ? 'block max-w-full bg-white' : 'hidden'} />
      {!visible && <span className="text-[10px] text-slate-400">Preview</span>}
    </div>
  );
}
