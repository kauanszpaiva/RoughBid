import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import {
  DEFAULT_TILE_GRID,
  DEFAULT_TILE_MIN_WALL_STROKES,
  MAX_TILE_GRID,
  boundedTileGrid,
  cropSheetRegion,
  describeRegion,
  describeRegionEvidence,
  mapNormalizedBoxFromRegion,
  planPageRegions,
  readSheetFrame,
  tileOptionsFromEnv,
} from '../src/ai-plan/page-tiles.ts';
import { dedupeOverlappingFindings, OpenAiCompatibleVisionPlanReader, requireOpenAiVisionConfig } from '../src/ai-plan/openai-vision.ts';
import { withUsageMeter } from '../src/owner-usage/meter.ts';
import type { DrawingLinework } from '../src/ai-plan/drawing-linework.ts';

const SHEET = { width: 1000, height: 800 };

/** The union of the regions must cover the whole sheet: an uncovered point is a blind spot. */
function coveredByRegions(regions: ReturnType<typeof planPageRegions>, x: number, y: number): number {
  return regions.filter(region =>
    x >= region.x && x <= region.x + region.width && y >= region.y && y <= region.y + region.height).length;
}

test('a tiled sheet is cut into overlapping regions that cover it completely', () => {
  const regions = planPageRegions(SHEET, 2);
  assert.equal(regions.length, 4);
  // Reading order from the top-left of the sheet, which is the highest y in PDF space.
  assert.deepEqual(regions.map(region => [region.column, region.row]), [[1, 1], [2, 1], [1, 2], [2, 2]]);
  for (const region of regions) {
    assert.ok(region.width > 0 && region.height > 0);
    assert.ok(region.x >= 0 && region.y >= 0);
    assert.ok(region.x + region.width <= SHEET.width + 1e-9, 'a region never leaves the sheet');
    assert.ok(region.y + region.height <= SHEET.height + 1e-9, 'a region never leaves the sheet');
    // Overlap is the point: without it a door drawn on a seam is cut in half and
    // missed by both neighbours, which is exactly the enumeration being fixed.
    assert.ok(region.width > SHEET.width / 2 && region.height > SHEET.height / 2);
  }
  // The centre sits on the seam of all four cells, so every region must include it.
  assert.equal(coveredByRegions(regions, 500, 400), 4);
  for (const x of [1, 250, 500, 750, 999]) {
    for (const y of [1, 200, 400, 600, 799]) {
      assert.ok(coveredByRegions(regions, x, y) >= 1, `no region covers ${x},${y}`);
    }
  }
});

test('the tile grid is bounded, and grid 1 is the off switch that returns the whole sheet', () => {
  assert.equal(boundedTileGrid(undefined), DEFAULT_TILE_GRID);
  assert.equal(boundedTileGrid(0), DEFAULT_TILE_GRID);
  assert.equal(boundedTileGrid(2), 2);
  assert.equal(boundedTileGrid(9), MAX_TILE_GRID);
  assert.deepEqual(planPageRegions(SHEET, 1), [{ column: 1, row: 1, columns: 1, rows: 1, x: 0, y: 0, width: 1000, height: 800 }]);
  // A malformed page still gets read rather than silently producing no regions.
  assert.deepEqual(planPageRegions({ width: 0, height: 0 }, 2), []);
  assert.equal(tileOptionsFromEnv({}).grid, 2);
  assert.equal(tileOptionsFromEnv({ AI_PLAN_OPENAI_TILE_GRID: '3' }).grid, 3);
  assert.equal(tileOptionsFromEnv({ AI_PLAN_OPENAI_TILE_GRID: '-4' }).grid, 2);
  assert.equal(tileOptionsFromEnv({}).minWallStrokes, DEFAULT_TILE_MIN_WALL_STROKES);
});

test('a box reported inside a region is restored to sheet coordinates', () => {
  const regions = planPageRegions(SHEET, 2);
  const topLeft = regions[0]!;
  // The region's own top-left corner.
  const origin = mapNormalizedBoxFromRegion([0, 0, 0.01, 0.01], topLeft, SHEET)!;
  assert.equal(origin[0], Number((topLeft.x / SHEET.width).toFixed(6)));
  assert.equal(origin[1], Number(((SHEET.height - topLeft.y - topLeft.height) / SHEET.height).toFixed(6)));
  // A box covering the whole region maps to that region's rectangle on the sheet.
  const whole = mapNormalizedBoxFromRegion([0, 0, 1, 1], topLeft, SHEET)!;
  assert.equal(whole[2], Number((topLeft.width / SHEET.width).toFixed(6)));
  assert.equal(whole[3], Number((topLeft.height / SHEET.height).toFixed(6)));
  // The region's bottom-right corner lands at the region's bottom-right on the sheet.
  const bottomRight = mapNormalizedBoxFromRegion([1, 1, 0.001, 0.001], topLeft, SHEET)!;
  assert.ok(Math.abs(bottomRight[0] - (topLeft.x + topLeft.width) / SHEET.width) < 0.002);
  assert.ok(Math.abs(bottomRight[1] - (SHEET.height - topLeft.y) / SHEET.height) < 0.002);
});

test('the same region-relative box maps to a different place in each region', () => {
  const regions = planPageRegions(SHEET, 2);
  const mapped = regions.map(region => mapNormalizedBoxFromRegion([0.45, 0.45, 0.05, 0.05], region, SHEET));
  assert.equal(mapped.every(Boolean), true);
  const keys = new Set(mapped.map(box => box!.join(',')));
  // Four regions, four distinct locations: this is the assertion that proves a
  // region box cannot be mistaken for a sheet box.
  assert.equal(keys.size, 4);
  // And each lands in its own quadrant.
  assert.ok(mapped[0]![0] < 0.6 && mapped[0]![1] < 0.4, 'top-left region maps to the top-left of the sheet');
  assert.ok(mapped[1]![0] > 0.4 && mapped[1]![1] < 0.4, 'top-right region maps top-right');
  assert.ok(mapped[2]![0] < 0.6 && mapped[2]![1] > 0.5, 'bottom-left region maps bottom-left');
  assert.ok(mapped[3]![0] > 0.4 && mapped[3]![1] > 0.5, 'bottom-right region maps bottom-right');
});

test('an unusable box is refused instead of guessed, because the viewer would draw it', () => {
  const region = planPageRegions(SHEET, 2)[0]!;
  assert.equal(mapNormalizedBoxFromRegion(undefined, region, SHEET), null);
  assert.equal(mapNormalizedBoxFromRegion([0.1, 0.1, 0.1], region, SHEET), null);
  assert.equal(mapNormalizedBoxFromRegion(['a', 'b', 'c', 'd'], region, SHEET), null);
  assert.equal(mapNormalizedBoxFromRegion([0.1, 0.1, 0, 0.2], region, SHEET), null);
  assert.equal(mapNormalizedBoxFromRegion([0.1, 0.1, 0.2, -0.2], region, SHEET), null);
  assert.equal(mapNormalizedBoxFromRegion([4, 0.1, 0.2, 0.2], region, SHEET), null);
  assert.equal(mapNormalizedBoxFromRegion([0.1, 9, 0.2, 0.2], region, SHEET), null);
  // A hair outside the region is a rounding artefact of a tight crop, not a lie.
  assert.notEqual(mapNormalizedBoxFromRegion([-0.005, -0.005, 0.1, 0.1], region, SHEET), null);
});

test('the region is named in the request so the model knows it sees a crop', () => {
  const regions = planPageRegions(SHEET, 2);
  assert.match(describeRegion(regions[0]!, SHEET), /region 1 of 2 columns \(left\), 1 of 2 rows \(top\)/);
  assert.match(describeRegion(regions[3]!, SHEET), /region 2 of 2 columns \(right\), 2 of 2 rows \(bottom\)/);
  assert.match(describeRegion(planPageRegions(SHEET, 1)[0]!, SHEET), /complete sheet/);
  const evidence = describeRegionEvidence({ region: regions[0]!, page: SHEET, physicalPage: 7, pageText: 'SHWR 70 sq.ft.' });
  assert.match(evidence, /physical PDF page 7/);
  assert.match(evidence, /TOP-LEFT OF THIS REGION|top-left of THIS region/i);
  assert.match(evidence, /SHWR 70 sq\.ft\./);
  assert.match(describeRegionEvidence({ region: regions[0]!, page: SHEET, physicalPage: 7, pageText: null }), /REGION REQUEST/);
});

test('the crop box is what makes the provider display the region zoomed', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([1000, 800]);
  const sheet = await doc.save();
  const frame = await readSheetFrame(sheet);
  assert.deepEqual(frame, { x: 0, y: 0, width: 1000, height: 800 });

  const region = planPageRegions(SHEET, 2)[0]!;
  const cropped = await cropSheetRegion(sheet, frame, region);
  const reloaded = await PDFDocument.load(cropped);
  const box = reloaded.getPage(0).getCropBox();
  assert.equal(box.width, region.width);
  assert.equal(box.height, region.height);
  assert.equal(box.x, region.x);
  assert.equal(box.y, region.y);
  // The sheet itself is untouched: the crop is a view, not an edit.
  assert.equal((await readSheetFrame(sheet)).width, 1000);
});

/** Dense enough to be worth cutting, in the shape the linework pass produces. */
const denseLinework = (pages: number): DrawingLinework => ({
  pages: Array.from({ length: pages }, (_, index) => ({
    pageNumber: index + 1,
    horizontal: { count: 4_000, totalPoints: 100_000, maxLengthPoints: 500 },
    vertical: { count: 4_000, totalPoints: 100_000, maxLengthPoints: 500 },
    diagonal: { count: 0, totalPoints: 0, maxLengthPoints: 0 },
    regions: [],
    spaces: [],
    openings: [],
    filledPaths: 0,
    curvedSegments: 0,
    rotation: 0,
    segments: 8_000,
    truncated: false,
  })),
  pageLimit: 100,
  truncated: false,
} as unknown as DrawingLinework);

async function planBytes(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let index = 1; index <= pages; index += 1) doc.addPage([1000, 800]).drawText(`SHEET ${index}`, { x: 40, y: 700, size: 12 });
  return doc.save();
}

test('a dense sheet is read as regions, one metered request each, and boxes are restored', async () => {
  const requests: Array<{ crop: { x: number; y: number; width: number; height: number }; prompt: string }> = [];
  const fetcher = (async (_url: string, init: any) => {
    const body = JSON.parse(String(init?.body));
    const part = body.messages?.[1]?.content?.find((entry: any) => entry?.type === 'file');
    const bytes = Uint8Array.from(Buffer.from(String(part.file.file_data).split(',')[1] ?? '', 'base64'));
    const limit = await PDFDocument.load(bytes);
    requests.push({ crop: limit.getPage(0).getCropBox(), prompt: String(body.messages[1].content[0].text) });
    const payload = {
      summary: { sheet_count: 1, detected_trade_scope: ['Framing'], scale_status: 'detected', limitations: [] },
      findings: [{
        page_number: 1, finding_type: 'symbol', label: 'door leaf and swing', value_text: 'drawn', quantity: null, unit: null,
        confidence: 0.7, source_excerpt: 'door leaf and swing arc visible in the drawn plan',
        // The same region-relative box in every region, so the mapping is what
        // has to make the locations differ.
        geometry: { bbox: [0.45, 0.45, 0.05, 0.05] },
      }],
    };
    return {
      ok: true, status: 200,
      json: async () => ({ id: 'x', usage: {}, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }] }),
    } as any;
  }) as unknown as typeof fetch;

  const config = requireOpenAiVisionConfig({
    OPENAI_PLAN_READING_ENABLED: 'true', OPENAI_API_KEY: 'sk-plan-reading-key',
    AI_PLAN_OPENAI_TILE_GRID: '2', AI_PLAN_OPENAI_TILE_MIN_WALL_STROKES: '1000',
    AI_PLAN_OPENAI_MAX_BATCHES: '10', AI_PLAN_OPENAI_TILE_MAX_PAGES: '5',
  });
  // A region request is per sheet: a window of four sheets cut nine ways would be
  // thirty-six requests that each see a quarter sheet.
  assert.equal(config.batchPages, 1);
  assert.equal(config.tileGrid, 2);

  const reader = new OpenAiCompatibleVisionPlanReader(config, fetcher);
  const bytes = await planBytes(2);
  const result = await withUsageMeter(
    { writer: { from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: async () => ({ error: null }) }) }), rpc: async () => ({ data: {}, error: null }) }, userId: 'u', workspaceId: 'w', projectId: 'p', jobId: 'j', billing: 'paid' },
    () => reader.read({
      fileBytes: bytes, mimeType: 'application/pdf', sheetName: 'set.pdf',
      requestedTrades: [], scope: null, pageCount: 2, linework: denseLinework(2),
    } as any),
  );

  // Two pages, four regions each, one metered provider request per region.
  assert.equal(requests.length, 8);
  assert.ok(requests.every(request => request.crop.width < 1000 && request.crop.height < 800), 'every request showed a crop of the sheet');
  assert.ok(requests.every(request => /ONE REGION of physical PDF page/.test(request.prompt)));
  assert.ok(requests.every(request => /door leaf and its swing arc/.test(request.prompt)));
  assert.ok(requests.every(request => /TOP-LEFT OF THIS REGION/.test(request.prompt)), 'the model is told which space its box is measured in');

  // The four regions of page 1 are the first four requests, in reading order.
  const firstPageCrops = new Set(requests.slice(0, 4).map(request => `${request.crop.x},${request.crop.y}`));
  assert.equal(firstPageCrops.size, 4, 'each region is a different crop of the same sheet');

  assert.equal(result.findings.length, 8);
  assert.deepEqual([...new Set(result.findings.map(finding => finding.page_number))].sort(), [1, 2]);
  const pageOneBoxes = new Set(result.findings.filter(finding => finding.page_number === 1).map(finding => JSON.stringify((finding.geometry as any).bbox)));
  assert.equal(pageOneBoxes.size, 4, 'the same region-relative box lands in four different places on the sheet');
  assert.ok(result.summary.limitations.some(note => /were read as 2x2 overlapping region\(s\)/.test(note)));
  assert.ok(!result.summary.limitations.some(note => /were never read/.test(note)));
});

test('a sparse sheet is read whole even when tiling is configured', async () => {
  let requests = 0;
  const fetcher = (async () => {
    requests += 1;
    const payload = {
      summary: { sheet_count: 1, detected_trade_scope: ['Framing'], scale_status: 'detected', limitations: [] },
      findings: [{ page_number: 1, finding_type: 'scope_note', label: 'cover', value_text: 'note only', quantity: null, unit: null, confidence: 0.6, source_excerpt: 'PROVIDE FIRE RATED ASSEMBLY' }],
    };
    return { ok: true, status: 200, json: async () => ({ id: 'x', usage: {}, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }] }) } as any;
  }) as unknown as typeof fetch;

  const sparse = denseLinework(2);
  for (const page of sparse.pages) {
    (page as { vertical: { count: number } }).vertical = { count: 10, totalPoints: 0, maxLengthPoints: 0 } as never;
    (page as { horizontal: { count: number } }).horizontal = { count: 10, totalPoints: 0, maxLengthPoints: 0 } as never;
  }
  const reader = new OpenAiCompatibleVisionPlanReader(requireOpenAiVisionConfig({
    OPENAI_PLAN_READING_ENABLED: 'true', OPENAI_API_KEY: 'sk-plan-reading-key',
    AI_PLAN_OPENAI_TILE_GRID: '3', AI_PLAN_OPENAI_TILE_MIN_WALL_STROKES: '1500',
    AI_PLAN_OPENAI_MAX_BATCHES: '10',
  }), fetcher);
  const sparseBytes = await planBytes(2);
  const result = await withUsageMeter(
    { writer: { from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: async () => ({ error: null }) }) }), rpc: async () => ({ data: {}, error: null }) }, userId: 'u', workspaceId: 'w', projectId: 'p', jobId: 'j', billing: 'paid' },
    () => reader.read({
      fileBytes: sparseBytes, mimeType: 'application/pdf', sheetName: 'set.pdf',
      requestedTrades: [], scope: null, pageCount: 2, linework: sparse,
    } as any),
  );
  // One request per sheet, not nine: a cover sheet has nothing to zoom into.
  assert.equal(requests, 2);
  assert.ok(!result.summary.limitations.some(note => /overlapping region/.test(note)));
});


test('overlapping crop evidence is deduplicated only when it maps to the same physical object', () => {
  const findings:any[]=[
    {
      page_number:1,finding_type:'symbol',label:'Door swing',value_text:null,quantity:null,unit:null,
      confidence:0.82,geometry:{bbox:[0.48,0.20,0.08,0.10]},source_excerpt:'door leaf and swing arc',
    },
    {
      page_number:1,finding_type:'symbol',label:'Unlabeled door',value_text:null,quantity:null,unit:null,
      confidence:0.94,geometry:{bbox:[0.482,0.202,0.079,0.099]},source_excerpt:'door leaf and swing arc',
    },
    {
      page_number:1,finding_type:'symbol',label:'Second door',value_text:null,quantity:null,unit:null,
      confidence:0.9,geometry:{bbox:[0.68,0.20,0.08,0.10]},source_excerpt:'another door leaf and swing arc',
    },
  ];
  const deduped=dedupeOverlappingFindings(findings);
  assert.equal(deduped.length,2);
  assert.ok(deduped.some(item=>item.label==='Unlabeled door'),'higher-confidence duplicate survives');
  assert.ok(deduped.some(item=>item.label==='Second door'),'distinct nearby door is not collapsed');
});
