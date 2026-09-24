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
  verifyFindingPages,
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

const findingOn = (page: number, excerpt: string) => ({
  page_number: page, finding_type: 'scope_note' as const, label: 'Evidence',
  value_text: null, quantity: null, unit: null, confidence: 0.7, geometry: {}, source_excerpt: excerpt,
});

const transcript = {
  pages: [
    { pageNumber: 1, characters: 60, text: 'GENERAL NOTES\nPROVIDE 24 LF OF KITCHEN BASE CABINET', truncated: false, headings: [], sheetNumber: 'A-000', scale: null, likelyScanned: false },
    { pageNumber: 2, characters: 60, text: 'KEYNOTES\n1. HARDWOOD FLOOR AT LIVING AND BEDROOM.', truncated: false, headings: [], sheetNumber: 'A-101', scale: null, likelyScanned: false },
    { pageNumber: 3, characters: 60, text: "D1 3'-0\" x 6'-8\" HOLLOW METAL DOOR 4 EA", truncated: false, headings: [], sheetNumber: 'A-601', scale: null, likelyScanned: false },
  ],
  pageLimit: 80, characterLimit: 30000, characters: 180, truncated: false,
};

test('a finding is kept when its quoted text really is on the cited page', () => {
  const check = verifyFindingPages([findingOn(2, 'KEYNOTES 1. HARDWOOD FLOOR AT LIVING AND BEDROOM.')], transcript);
  assert.equal(check.corrected, 0);
  assert.equal(check.unlocated, 0);
  assert.equal(check.checked, 1);
  assert.equal(check.findings[0]!.page_number, 2);
});

test('a page number the model got wrong is corrected from the local transcript', () => {
  // Observed on a real call: keynote rooms reported on the schedule sheet.
  const check = verifyFindingPages([findingOn(3, 'KEYNOTES\n1. HARDWOOD FLOOR AT LIVING AND BEDROOM.')], transcript);
  assert.equal(check.corrected, 1);
  assert.equal(check.findings[0]!.page_number, 2);
  assert.equal(check.findings[0]!.source_excerpt, 'KEYNOTES\n1. HARDWOOD FLOOR AT LIVING AND BEDROOM.');
});

test('matching ignores case, whitespace and punctuation differences', () => {
  const check = verifyFindingPages([findingOn(3, "d1 3'-0\"  x  6'-8\" hollow-metal door 4 ea")], transcript);
  // The cited page is right, so nothing is corrected: normalization is what locates it.
  assert.equal(check.corrected, 0);
  assert.equal(check.unlocated, 0);
  assert.equal(check.findings[0]!.page_number, 3);
});

test('a finding whose text appears on two pages is left alone rather than guessed', () => {
  const ambiguous = {
    ...transcript,
    pages: [
      transcript.pages[0]!,
      { ...transcript.pages[1]!, text: 'GENERAL NOTES\nPROVIDE 24 LF OF KITCHEN BASE CABINET' },
      transcript.pages[2]!,
    ],
  };
  const check = verifyFindingPages([findingOn(3, 'PROVIDE 24 LF OF KITCHEN BASE CABINET')], ambiguous);
  assert.equal(check.corrected, 0);
  assert.equal(check.unlocated, 1);
  assert.equal(check.findings[0]!.page_number, 3);
});

test('evidence that no transcribed page contains is kept and counted, never dropped', () => {
  const check = verifyFindingPages([findingOn(1, 'JOG IN EXTERIOR SHEATHING AT CORNER')], transcript);
  assert.equal(check.findings.length, 1);
  assert.equal(check.unlocated, 1);
  assert.equal(check.corrected, 0);
});

test('short excerpts and this pipeline own geometry citations are not page-checked', () => {
  const check = verifyFindingPages([
    findingOn(1, 'SF'),
    findingOn(1, 'Deterministic PDF vector linework: closed axis-aligned outline of 6 segments, page bbox [0.1, 0.2, 0.3, 0.2] normalized.'),
  ], transcript);
  assert.equal(check.checked, 0);
  assert.equal(check.corrected, 0);
  assert.equal(check.unlocated, 0);
});

test('without a transcript nothing is changed or claimed', () => {
  const findings = [findingOn(3, 'KEYNOTES 1. HARDWOOD FLOOR AT LIVING AND BEDROOM.')];
  const check = verifyFindingPages(findings, undefined);
  assert.deepEqual(check.findings, findings);
  assert.deepEqual([check.checked, check.corrected, check.unlocated], [0, 0, 0]);
});
