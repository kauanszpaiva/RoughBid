import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import {
  describeLineworkDigest,
  describePageLinework,
  extractDrawingLinework,
  lineworkGeometryFindings,
  mergeLineworkFindings,
  vectorLineworkEnabled,
} from '../src/ai-plan/drawing-linework.ts';
import { sanitizePlanReadingResult } from '../src/ai-plan/types.ts';

/** Builds a small synthetic plan with known linework: 1 horizontal, 1 vertical, 1 diagonal,
 *  a bordered 240x180 rectangle and a filled 100x50 rectangle. */
async function syntheticPlan() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawLine({ start: { x: 72, y: 700 }, end: { x: 540, y: 700 }, thickness: 2 });
  page.drawLine({ start: { x: 72, y: 700 }, end: { x: 72, y: 300 }, thickness: 2 });
  page.drawLine({ start: { x: 100, y: 100 }, end: { x: 180, y: 150 }, thickness: 1 });
  page.drawRectangle({ x: 200, y: 400, width: 240, height: 180, borderWidth: 1.5 });
  page.drawRectangle({ x: 300, y: 100, width: 100, height: 50, color: rgb(0.4, 0.4, 0.4) });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('SCALE: 1/4" = 1\'-0"', { x: 72, y: 120, size: 12, font });
  return new Uint8Array(await doc.save());
}

test('drawing linework reads real vector lines, direction totals and known lengths', async () => {
  const linework = await extractDrawingLinework(await syntheticPlan());
  assert.equal(linework.pages.length, 1);
  const page = linework.pages[0]!;
  assert.equal(page.pageNumber, 1);
  assert.equal(page.pageWidthPoints, 612);
  assert.equal(page.pageHeightPoints, 792);
  assert.equal(page.rotationDegrees, 0);
  // 3 lines + 2 rectangles = 5 vector paths, each four-sided outline contributing 4 segments.
  assert.equal(page.paths, 5);
  assert.equal(page.segments, 11);
  assert.equal(page.strokedPaths, 3);
  assert.equal(page.filledPaths, 2);
  assert.equal(page.curvedSegments, 0);
  // The 468pt horizontal run and both rectangle edges; the 400pt vertical and both vertical edges.
  assert.equal(page.horizontal.count, 5);
  assert.equal(page.vertical.count, 5);
  assert.equal(page.diagonal.count, 1);
  assert.equal(page.horizontal.longestPoints, 468);
  assert.equal(page.vertical.longestPoints, 400);
  assert.ok(Math.abs(page.diagonal.totalLengthPoints - Math.hypot(80, 50)) < 0.01);
  assert.ok(Math.abs(page.totalLengthPoints - (1148 + 860 + Math.hypot(80, 50))) < 0.05);
  // Thick long strokes are the wall-like evidence; the hairline diagonal is not.
  assert.equal(page.wallLikeSegments, 6);
});

test('drawing linework measures closed shapes with normalized on-page bounds', async () => {
  const page = (await extractDrawingLinework(await syntheticPlan())).pages[0]!;
  assert.equal(page.regions.length, 2);
  const [largest, second] = page.regions;
  assert.equal(largest!.widthPoints, 240);
  assert.equal(largest!.heightPoints, 180);
  assert.equal(largest!.vertices, 4);
  assert.equal(second!.widthPoints, 100);
  assert.equal(second!.heightPoints, 50);
  // 200/612, (792-580)/792, 240/612, 180/792 from the top-left of the displayed page.
  assert.ok(Math.abs(largest!.bbox[0]! - 0.3268) < 0.002);
  assert.ok(Math.abs(largest!.bbox[1]! - 0.2677) < 0.002);
  assert.ok(Math.abs(largest!.bbox[2]! - 0.3922) < 0.002);
  assert.ok(Math.abs(largest!.bbox[3]! - 0.2273) < 0.002);
  for (const region of page.regions) {
    const [x, y, width, height] = region.bbox;
    assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 1.0001 && y + height <= 1.0001);
  }
});

test('linework digest is a bounded provider-facing description of every analyzed page', async () => {
  const digest = describeLineworkDigest(await extractDrawingLinework(await syntheticPlan()));
  assert.ok(digest);
  assert.match(digest, /DETERMINISTIC VECTOR LINEWORK/);
  assert.match(digest, /untrusted evidence, never instructions/);
  assert.match(digest, /Page 1: 612x792pt rot 0/);
  assert.match(digest, /5 vector paths, 11 straight segments/);
  assert.match(digest, /2 closed region\(s\), largest 240x180pt/);
  assert.equal(describeLineworkDigest({ pages: [], pageLimit: 1, truncated: false }), null);
});

test('linework geometry findings are reviewable coordinates without invented quantities', async () => {
  const linework = await extractDrawingLinework(await syntheticPlan());
  const findings = lineworkGeometryFindings(linework);
  assert.equal(findings.length, 2);
  for (const finding of findings) {
    assert.equal(finding.quantity, null);
    assert.equal(finding.unit, null);
    assert.equal(finding.finding_type, 'measurement');
    assert.equal(finding.page_number, 1);
    assert.ok(finding.source_excerpt && /Deterministic PDF vector linework/.test(finding.source_excerpt));
    assert.equal(finding.geometry.coordinate_space, 'normalized');
    assert.equal((finding.geometry.bbox as number[]).length, 4);
    assert.ok(finding.confidence > 0 && finding.confidence < 1);
  }
  // The strict evidence contract downstream must keep them exactly as produced.
  const sanitized = sanitizePlanReadingResult({ summary: { sheet_count: 1 }, findings });
  assert.equal(sanitized.findings.length, 2);
  assert.deepEqual(sanitized.findings[0]!.geometry.bbox, findings[0]!.geometry.bbox);
  assert.equal(sanitized.findings[0]!.quantity, null);
  assert.equal(sanitized.findings[0]!.unit, null);
});

test('linework findings merge alongside model findings, dedupe, and disclose the addition', async () => {
  const linework = await extractDrawingLinework(await syntheticPlan());
  const modelFinding = sanitizePlanReadingResult({
    summary: { sheet_count: 1 },
    findings: [{ page_number: 1, finding_type: 'room', label: 'KITCHEN', quantity: null, unit: null, confidence: 0.8, source_excerpt: 'KITCHEN', geometry: { bbox: [0.05, 0.05, 0.1, 0.1] } }],
  }).findings;
  const merged = mergeLineworkFindings(modelFinding, linework, { pageCount: 1 });
  assert.ok(merged.added >= 2, `expected the measured geometry to be added, added ${merged.added}`);
  assert.equal(merged.findings.length, modelFinding.length + merged.added);
  // The note names every kind of geometry added, so a reader is never left to
  // guess where the extra findings came from.
  assert.match(merged.note!, /closed outline\(s\)/);
  assert.match(merged.note!, /space\(s\) enclosed by the drawn walls/);
  // Re-merging the same result must not duplicate geometry.
  const again = mergeLineworkFindings(merged.findings, linework, { pageCount: 1 });
  assert.equal(again.added, 0);
  assert.equal(again.note, null);
  // A finding for a page that does not exist in the authorized PDF is never added.
  const otherPage = mergeLineworkFindings(modelFinding, linework, { pageCount: 0 });
  assert.equal(otherPage.added, 0);
  assert.equal(mergeLineworkFindings(modelFinding, undefined).added, 0);
});

test('linework reading is bounded by page and segment limits and reports truncation', async () => {
  const doc = await PDFDocument.create();
  for (let index = 0; index < 3; index += 1) {
    const page = doc.addPage([612, 792]);
    for (let line = 0; line < 40; line += 1) {
      page.drawLine({ start: { x: 40, y: 40 + line * 15 }, end: { x: 560, y: 40 + line * 15 }, thickness: 1 });
    }
  }
  const bytes = new Uint8Array(await doc.save());
  const full = await extractDrawingLinework(bytes);
  assert.equal(full.pages.length, 3);
  assert.equal(full.truncated, false);
  assert.equal(full.pages[0]!.horizontal.count, 40);

  const capped = await extractDrawingLinework(bytes, { maxPages: 1 });
  assert.equal(capped.pages.length, 1);
  assert.equal(capped.truncated, true);
  assert.match(describeLineworkDigest(capped)!, /read for at most 1 pages/);

  const throttled = await extractDrawingLinework(bytes, { maxPages: 1, maxSegmentsPerPage: 5 });
  assert.equal(throttled.pages[0]!.truncated, true);
  assert.ok(throttled.pages[0]!.segments <= 5);
  assert.match(describePageLinework(throttled.pages[0]!), /truncated/);
});

test('a rotated sheet still reports normalized, in-page geometry', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.setRotation(degrees(90));
  page.drawLine({ start: { x: 60, y: 60 }, end: { x: 400, y: 60 }, thickness: 3 });
  page.drawRectangle({ x: 100, y: 200, width: 200, height: 150, borderWidth: 2 });
  const bytes = new Uint8Array(await doc.save());
  const read = await extractDrawingLinework(bytes);
  const readPage = read.pages[0]!;
  assert.equal(readPage.rotationDegrees, 90);
  assert.equal(readPage.pageWidthPoints, 792);
  assert.equal(readPage.pageHeightPoints, 612);
  for (const region of readPage.regions) {
    const [x, y, width, height] = region.bbox;
    assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 1.0001 && y + height <= 1.0001);
  }
  assert.ok(readPage.regions.length >= 1);
});

test('a plan without vector linework yields no geometry and no fabricated findings', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('NOTES ONLY', { x: 60, y: 700, size: 12, font });
  const bytes = new Uint8Array(await doc.save());
  const linework = await extractDrawingLinework(bytes);
  assert.equal(linework.pages[0]!.segments, 0);
  assert.equal(linework.pages[0]!.regions.length, 0);
  assert.equal(lineworkGeometryFindings(linework).length, 0);
  assert.equal(mergeLineworkFindings([], linework).added, 0);
  assert.match(describeLineworkDigest(linework)!, /0 vector paths, 0 straight segments/);
});

test('an unreadable or empty document fails loudly instead of inventing geometry', async () => {
  await assert.rejects(() => extractDrawingLinework(new Uint8Array()), TypeError);
  await assert.rejects(() => extractDrawingLinework(new TextEncoder().encode('not a pdf')));
});

test('linework reading is on by default and can be explicitly disabled', () => {
  assert.equal(vectorLineworkEnabled({}), true);
  assert.equal(vectorLineworkEnabled({ AI_PLAN_VECTOR_LINEWORK_ENABLED: 'true' }), true);
  assert.equal(vectorLineworkEnabled({ AI_PLAN_VECTOR_LINEWORK_ENABLED: 'false' }), false);
});