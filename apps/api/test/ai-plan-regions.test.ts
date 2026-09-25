import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import {
  cropPdfRegions,
  denseDrawingPages,
  mergeRegionFindings,
  overlappingRegions,
  remapRegionFinding,
} from '../src/ai-plan/plan-regions.ts';

test('four overlapping regions cover the whole physical page without seam gaps', () => {
  const regions = overlappingRegions(7);
  assert.deepEqual(regions.map(region => region.id), ['top_left','top_right','bottom_left','bottom_right']);
  assert.deepEqual(regions.map(region => region.pageNumber), [7,7,7,7]);
  assert.deepEqual(regions.map(region => region.bbox), [
    [0,0,0.6,0.6],
    [0.4,0,0.6,0.6],
    [0,0.4,0.6,0.6],
    [0.4,0.4,0.6,0.6],
  ]);
});

test('dense page selection uses measured drawing geometry rather than printed labels', () => {
  const pages = denseDrawingPages({
    pages: [
      { pageNumber: 1, spaces: [], openings: [], wallLikeSegments: 2, segments: 50, truncated: false },
      { pageNumber: 2, spaces: [{ bbox:[0,0,0.1,0.1], widthPoints:10, heightPoints:10, areaFraction:0.001, size:'small' }], openings: [], wallLikeSegments: 2, segments: 50, truncated: false },
      { pageNumber: 3, spaces: [], openings: [], wallLikeSegments: 80, segments: 50, truncated: false },
      { pageNumber: 4, spaces: [], openings: [], wallLikeSegments: 2, segments: 5000, truncated: false },
    ] as any,
    pageLimit: 100, pageLimitReached: false, segmentLimitedPages: [], truncated: false,
  }, 4);
  assert.deepEqual(pages, [2,3,4]);
});

test('one dense physical page becomes a four-page vector crop PDF', async () => {
  const source = await PDFDocument.create();
  source.addPage([1000, 800]);
  const { bytes, regions } = await cropPdfRegions(source, 1);
  const cropped = await PDFDocument.load(bytes);
  assert.equal(cropped.getPageCount(), 4);
  assert.deepEqual(cropped.getPages().map(page => [page.getWidth(), page.getHeight()]), [
    [600,480],[600,480],[600,480],[600,480],
  ]);
  assert.equal(regions.length, 4);
});

test('crop-local finding geometry is remapped onto the original physical sheet', () => {
  const region = overlappingRegions(9)[1]!;
  const finding: any = {
    page_number: 1, finding_type: 'symbol', label: 'unlabeled door swing',
    value_text: 'drawn door leaf and swing', quantity: null, unit: null, confidence: 0.9,
    source_excerpt: 'drawn door leaf and swing', geometry: { bbox: [0.1,0.2,0.2,0.3], coordinate_space:'normalized' },
  };
  const remapped = remapRegionFinding(finding, region);
  assert.equal(remapped.page_number, 9);
  assert.deepEqual((remapped.geometry.bbox as number[]).map((n:number)=>Number(n.toFixed(3))), [0.46,0.12,0.12,0.18]);
});

test('overlap duplicates collapse but distinct nearby objects survive', () => {
  const base: any[] = [{
    page_number: 1, finding_type:'symbol', label:'Door swing', value_text:null, quantity:null, unit:null,
    confidence:0.7, source_excerpt:'drawn swing', geometry:{bbox:[0.45,0.2,0.1,0.1]},
  }];
  const supplemental: any[] = [
    {
      page_number:1, finding_type:'symbol', label:'Door swing', value_text:'regional', quantity:null, unit:null,
      confidence:0.95, source_excerpt:'drawn swing', geometry:{bbox:[0.452,0.202,0.1,0.1]},
    },
    {
      page_number:1, finding_type:'symbol', label:'Door swing', value_text:'second door', quantity:null, unit:null,
      confidence:0.9, source_excerpt:'another drawn swing', geometry:{bbox:[0.7,0.2,0.08,0.1]},
    },
  ];
  const merged = mergeRegionFindings(base, supplemental);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]!.confidence, 0.95);
});
