import { classifyNativePageContent, type NativePageContentClassification } from './native-content-classifier.ts';

export type NativePageAnalysis = NativePageContentClassification & {
  textCharacters: number;
  vectorOperations: number;
  imageOperations: number;
};

function integerOps(values: Array<number | undefined>): Set<number> {
  return new Set(values.filter((value): value is number => Number.isSafeInteger(value)));
}

export async function analyzePdfNativeContent(fileBytes: Uint8Array): Promise<ReadonlyMap<number, NativePageAnalysis>> {
  if (!(fileBytes instanceof Uint8Array) || fileBytes.byteLength === 0) throw new TypeError('A non-empty PDF is required.');
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = getDocument({ data: fileBytes.slice() });
  const document = await loadingTask.promise;
  const result = new Map<number, NativePageAnalysis>();
  const imageOps = integerOps([
    OPS.paintImageXObject,
    OPS.paintInlineImageXObject,
    OPS.paintImageMaskXObject,
  ]);
  const vectorOps = integerOps([
    OPS.constructPath,
    OPS.stroke,
    OPS.closeStroke,
    OPS.fill,
    OPS.eoFill,
    OPS.fillStroke,
    OPS.eoFillStroke,
    OPS.closeFillStroke,
    OPS.closeEOFillStroke,
    OPS.shadingFill,
  ]);

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const [textContent, operatorList] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
        const text = textContent.items.map((item) => ('str' in item && typeof item.str === 'string' ? item.str : '')).join('');
        const compactText = text.replace(/\s/g, '');
        const replacementCharacters = (compactText.match(/\uFFFD/g) ?? []).length;
        let imageOperations = 0;
        let vectorOperations = 0;
        for (const operation of operatorList.fnArray) {
          if (imageOps.has(operation)) imageOperations += 1;
          if (vectorOps.has(operation)) vectorOperations += 1;
        }
        const stats = {
          textCharacters: compactText.length,
          vectorOperations,
          imageOperations,
          replacementCharacters,
        };
        result.set(pageNumber, { ...classifyNativePageContent(stats), ...stats });
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await loadingTask.destroy();
  }

  return result;
}
