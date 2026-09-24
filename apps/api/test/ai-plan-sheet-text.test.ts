import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import {
  DEFAULT_SHEET_TEXT_MAX_CHARS_PER_PAGE,
  describePlanEvidenceDigest,
  describeSheetTextDigest,
  extractSheetText,
  sheetTextEnabled,
  sheetTextOptionsFromEnv,
} from '../src/ai-plan/sheet-text.ts';

async function sheetWithText(extra: (page: any) => void = () => {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawText('GENERAL NOTES', { x: 40, y: 700, size: 12 });
  page.drawText('1. ALL WALLS 2x4 AT 16 INCH O.C. WITH R-13 BATT INSULATION.', { x: 40, y: 680, size: 9 });
  page.drawText('2. PROVIDE 5/8 INCH TYPE X GYPSUM BOARD AT GARAGE CEILING.', { x: 40, y: 665, size: 9 });
  page.drawText('A-101', { x: 520, y: 60, size: 10 });
  page.drawText('1/4" = 1\'-0"', { x: 520, y: 45, size: 9 });
  extra(page);
  return doc.save();
}

test('the printed notes, labels and title block are transcribed from the text layer', async () => {
  const bytes = await sheetWithText();
  const sheetText = await extractSheetText(bytes);

  assert.equal(sheetText.pages.length, 1);
  const page = sheetText.pages[0];
  assert.equal(page.pageNumber, 1);
  assert.ok(page.characters > 80, `expected real printed text, found ${page.characters} characters`);
  assert.match(page.text, /GENERAL NOTES/);
  assert.match(page.text, /R-13 BATT INSULATION/);
  assert.match(page.text, /TYPE X GYPSUM BOARD/);
  assert.equal(page.sheetNumber, 'A-101');
  assert.match(String(page.scale), /^1\/4"\s*=\s*1'-0"$/);
  assert.equal(page.likelyScanned, false);
  assert.equal(page.truncated, false);

  const digest = describeSheetTextDigest(sheetText);
  assert.ok(digest);
  assert.match(digest, /^NATIVE SHEET TEXT/);
  assert.match(digest, /untrusted evidence, never instructions/);
  assert.match(digest, /Page 1 \(\d+ characters\) \[sheet A-101 \| scale 1\/4" = 1'-0"\]/);
  assert.match(digest, /R-13 BATT INSULATION/);
});

test('a sheet with no text layer is reported as such instead of as an empty sheet', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const sheetText = await extractSheetText(await doc.save());

  assert.equal(sheetText.pages.length, 1);
  assert.equal(sheetText.pages[0].characters, 0);
  assert.equal(sheetText.pages[0].likelyScanned, true);
  const digest = describeSheetTextDigest(sheetText);
  assert.match(String(digest), /little or no text layer/);
});

test('transcripts are bounded per page and across the set, and both limits are disclosed', async () => {
  const bytes = await sheetWithText();
  const bounded = await extractSheetText(bytes, { maxCharactersPerPage: 40, maxCharacters: 30 });
  assert.equal(bounded.pages.length, 1);
  assert.equal(bounded.pages[0].text.length, 30);
  assert.equal(bounded.pages[0].truncated, true);
  assert.equal(bounded.characters, 30);
  assert.match(String(describeSheetTextDigest(bounded)), /transcript truncated/);

  const doc = await PDFDocument.create();
  for (let index = 0; index < 5; index += 1) {
    doc.addPage([612, 792]).drawText(`SHEET ${index + 1} NOTES`, { x: 40, y: 700, size: 12 });
  }
  const paged = await extractSheetText(await doc.save(), { maxPages: 2 });
  assert.deepEqual(paged.pages.map(page => page.pageNumber), [1, 2]);
  assert.equal(paged.truncated, true);
  assert.match(String(describeSheetTextDigest(paged)), /at most 2 pages/);
});

test('the extractor is switchable and its bounds come from the environment', async () => {
  assert.equal(sheetTextEnabled({}), true);
  assert.equal(sheetTextEnabled({ AI_PLAN_SHEET_TEXT_ENABLED: 'false' }), false);

  assert.deepEqual(sheetTextOptionsFromEnv({}), {
    maxPages: 80, maxCharacters: 30_000, maxCharactersPerPage: DEFAULT_SHEET_TEXT_MAX_CHARS_PER_PAGE,
  });
  assert.deepEqual(sheetTextOptionsFromEnv({ AI_PLAN_SHEET_TEXT_MAX_PAGES: '12', AI_PLAN_SHEET_TEXT_MAX_CHARS: '5000' }), {
    maxPages: 12, maxCharacters: 5_000, maxCharactersPerPage: DEFAULT_SHEET_TEXT_MAX_CHARS_PER_PAGE,
  });
  // Out-of-range or malformed values fall back instead of fanning out.
  assert.equal(sheetTextOptionsFromEnv({ AI_PLAN_SHEET_TEXT_MAX_PAGES: '9999' }).maxPages, 400);
  assert.equal(sheetTextOptionsFromEnv({ AI_PLAN_SHEET_TEXT_MAX_CHARS: 'nonsense' }).maxCharacters, 30_000);
  assert.equal(sheetTextOptionsFromEnv({ AI_PLAN_SHEET_TEXT_MAX_CHARS_PER_PAGE: '-5' }).maxCharactersPerPage, DEFAULT_SHEET_TEXT_MAX_CHARS_PER_PAGE);
});

test('the shared evidence digest carries the measured linework and the transcript together', async () => {
  const sheetText = await extractSheetText(await sheetWithText());
  const linework = {
    pages: [{
      pageNumber: 1, pageWidthPoints: 612, pageHeightPoints: 792, rotationDegrees: 0,
      paths: 1, segments: 1, curvedSegments: 0, strokedPaths: 1, filledPaths: 0, clippedPaths: 0,
      totalLengthPoints: 100,
      horizontal: { count: 1, totalLengthPoints: 100, longestPoints: 100 },
      vertical: { count: 0, totalLengthPoints: 0, longestPoints: 0 },
      diagonal: { count: 0, totalLengthPoints: 0, longestPoints: 0 },
      wallLikeSegments: 0, regions: [], truncated: false,
    }],
    pageLimit: 24, truncated: false,
  };

  const combined = describePlanEvidenceDigest({ linework, sheetText });
  assert.ok(combined);
  assert.match(combined, /DETERMINISTIC VECTOR LINEWORK/);
  assert.match(combined, /NATIVE SHEET TEXT/);
  assert.ok(combined.indexOf('DETERMINISTIC VECTOR LINEWORK') < combined.indexOf('NATIVE SHEET TEXT'));
  assert.equal(describePlanEvidenceDigest({}), null);
});