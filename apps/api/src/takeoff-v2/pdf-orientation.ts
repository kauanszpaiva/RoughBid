import type { PageRegion } from '../ai-plan/page-tiles.ts';

export type PdfRotation = 0 | 90 | 180 | 270;
export function normalizedPdfRotation(value: number): PdfRotation {
  if (!Number.isFinite(value) || value % 90 !== 0) throw new Error('PDF page rotation must be a right angle.');
  return ((value % 360 + 360) % 360) as PdfRotation;
}

/** PDF CropBox-relative coordinates stay unrotated in persistence. This is the
 * corresponding displayed top-left rectangle, after the PDF's clockwise Rotate.
 * It is source coverage, never inferred measurement geometry. */
export function displayedRegionBounds(region: Pick<PageRegion,'x'|'y'|'width'|'height'>,
  pageWidth: number,pageHeight: number,rotation: PdfRotation) {
  const {x,y,width,height}=region;
  if (![x,y,width,height,pageWidth,pageHeight].every(Number.isFinite) || x<0 || y<0 || width<=0 || height<=0
    || x+width>pageWidth+1e-6 || y+height>pageHeight+1e-6) throw new Error('PDF region is outside its source frame.');
  const quarter=rotation===90||rotation===270;
  const bounds=rotation===90 ? {x:y,y:x,width:height,height:width}
    : rotation===180 ? {x:pageWidth-x-width,y,width,height}
    : rotation===270 ? {x:pageHeight-y-height,y:pageWidth-x-width,width:height,height:width}
    : {x,y:pageHeight-y-height,width,height};
  return {...bounds,pageWidth:quarter?pageHeight:pageWidth,pageHeight:quarter?pageWidth:pageHeight,
    coordinateSpace:'displayed_cropbox_top_left_points' as const};
}
