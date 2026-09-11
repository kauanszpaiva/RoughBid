import { PDFDocument } from 'pdf-lib';
import { analyzePdfNativeContent } from './native-content.ts';
import type { PlanSetManifest } from './types.ts';

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

/** Deterministic preflight: accounts for every physical page before semantic AI begins. */
export async function createPlanSetManifest(fileBytes: Uint8Array): Promise<PlanSetManifest> {
  if (!(fileBytes instanceof Uint8Array) || fileBytes.byteLength === 0) throw new TypeError('A non-empty PDF is required.');
  const source = await PDFDocument.load(fileBytes, { ignoreEncryption: false, updateMetadata: false });
  if (source.getPageCount() < 1) throw new RangeError('The PDF has no physical pages.');

  // Native PDF inspection is best-effort. It improves routing for vector/mixed/
  // raster pages, but an analyzer failure must not make a valid plan unreadable.
  const nativeContent = await analyzePdfNativeContent(fileBytes).catch(() => new Map());
  const sheets = [];
  for (let index = 0; index < source.getPageCount(); index += 1) {
    const page = source.getPage(index);
    const single = await PDFDocument.create();
    const [copied] = await single.copyPages(source, [index]);
    single.addPage(copied!);
    const pageBytes = await single.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
    const { width, height } = page.getSize();
    const rotation = page.getRotation().angle;
    const rotationDegrees = ([0, 90, 180, 270].includes(rotation) ? rotation : 0) as 0 | 90 | 180 | 270;
    const native = nativeContent.get(index + 1);
    sheets.push({
      physicalPageNumber: index + 1,
      pageSha256: await sha256(pageBytes),
      widthPoints: Number(width.toFixed(6)),
      heightPoints: Number(height.toFixed(6)),
      orientation: width === height ? 'square' as const : width > height ? 'landscape' as const : 'portrait' as const,
      rotationDegrees,
      contentKind: native?.contentKind ?? 'unknown' as const,
      textQuality: native?.textQuality ?? 'unknown' as const,
      nativeScaleCandidates: native?.printedScaleCandidates ?? [],
      status: 'review_required' as const,
      statusReason: native
        ? `Physical page accounted for; native content detected as ${native.contentKind} with ${native.textQuality} text.`
        : 'Physical page accounted for; native content inspection was unavailable and classification has not run.',
    });
  }
  return { fileSha256: await sha256(fileBytes), physicalPageCount: sheets.length, sheets };
}
