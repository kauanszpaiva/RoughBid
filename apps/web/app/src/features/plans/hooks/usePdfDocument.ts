import { useEffect, useState } from 'react';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export type PdfDocumentState = {
  pdf: pdfjs.PDFDocumentProxy | null;
  status: 'idle' | 'loading' | 'ready' | 'failed';
  error: string | null;
};

export function usePdfDocument(previewUrl: string | null | undefined): PdfDocumentState {
  const [state, setState] = useState<PdfDocumentState>({
    pdf: null,
    status: previewUrl ? 'loading' : 'idle',
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let loadingTask: ReturnType<typeof pdfjs.getDocument> | undefined;

    setState({ pdf: null, status: previewUrl ? 'loading' : 'idle', error: null });
    if (!previewUrl) return () => controller.abort();

    void (async () => {
      try {
        const response = await fetch(previewUrl, { signal: controller.signal });
        if (!response.ok) throw new Error(`Unable to open this PDF (${response.status}).`);
        const data = await response.arrayBuffer();
        if (cancelled) return;
        loadingTask = pdfjs.getDocument({ data });
        const pdf = await loadingTask.promise;
        if (!cancelled) setState({ pdf, status: 'ready', error: null });
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return;
        setState({
          pdf: null,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unable to open this PDF.',
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      void loadingTask?.destroy();
    };
  }, [previewUrl]);

  return state;
}
