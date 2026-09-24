import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import {
  DEFAULT_SHEET_TEXT_MAX_CHARS_PER_PAGE,
  describePlanEvidenceDigest,
  describeSheetTextDigest,
  extractSheetText,
  sheetTextEnabled,
  pickSheetNumber,
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
    maxPages: 80, maxCharacters: 60_000, maxCharactersPerPage: DEFAULT_SHEET_TEXT_MAX_CHARS_PER_PAGE,
  });
  assert.deepEqual(sheetTextOptionsFromEnv({ AI_PLAN_SHEET_TEXT_MAX_PAGES: '12', AI_PLAN_SHEET_TEXT_MAX_CHARS: '5000' }), {
    maxPages: 12, maxCharacters: 5_000, maxCharactersPerPage: DEFAULT_SHEET_TEXT_MAX_CHARS_PER_PAGE,
  });
  // Out-of-range or malformed values fall back instead of fanning out.
  assert.equal(sheetTextOptionsFromEnv({ AI_PLAN_SHEET_TEXT_MAX_PAGES: '9999' }).maxPages, 400);
  assert.equal(sheetTextOptionsFromEnv({ AI_PLAN_SHEET_TEXT_MAX_CHARS: 'nonsense' }).maxCharacters, 60_000);
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
test('a real title block is found even when the number is glued to its scale', () => {
  // Shape printed by Revit/AutoCAD under every view, with the note sheet's own
  // number far from the end of the text stream.
  const lines = [
    'LIFE SAFETY LEGEND',
    'CEILING SURFACE-MOUNTED COMBINED',
    ...Array.from({ length: 30 }, (_, index) => `NOTE ${index + 1}: INSTALL PER MANUFACTURER`),
    'Project Number:', 'MATNAH DESIGN STUDIO', '34 ELLIS ST MEDWAY, MA',
    'FLOOR PLANS', 'AND ELEVATIONS', 'A1.0', 'Feb. 10th, 2026', 'PERMIT SET',
    '1/4" = 1\'-0"A1.0', '5 REAR ELEVATION', '1/4" = 1\'-0"A1.0', '3 FRONT ELEVATION',
    'Window Schedule', 'Grand total: 10',
  ];
  assert.equal(pickSheetNumber(lines), 'A1.0');
});

test('a notes sheet reports its own number, not the code sections it cites most', () => {
  const lines = [
    'CEILING. - IRC R309.2 AND R302.6',
    'R303.4', 'R303.4', 'R905.2.2', 'R905.2.2', 'R905.2.2',
    'UNDERLAYMENT IS INSTALLED IN ACCORDANCE WITH IRC SECTION R905.2.2',
    'A0.2', 'A0.2', 'GENERAL NOTES',
  ];
  assert.equal(pickSheetNumber(lines), 'A0.2');
});

test('a labelled title-block line outranks a repeated opening tag', () => {
  const lines = ['W2', 'W2', 'W2', 'SHEET A-101', 'FIRST FLOOR PLAN'];
  assert.equal(pickSheetNumber(lines), 'A-101');
});

test('a long sheet keeps both ends of its transcript, so the title block survives', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont('Helvetica');
  const page = doc.addPage([612, 792]);
  page.drawText('GENERAL NOTES', { x: 40, y: 750, size: 12, font });
  for (let index = 0; index < 200; index += 1) {
    page.drawText(`${index + 1}. SEAL ALL PENETRATIONS THROUGH THE THERMAL ENVELOPE.`, { x: 40, y: 730 - index * 3, size: 8, font });
  }
  page.drawText('SHEET A-900 SCALE 1/4" = 1\'-0"', { x: 40, y: 20, size: 8, font });
  const sheet = await extractSheetText(await doc.save(), { maxCharactersPerPage: 900 });
  const only = sheet.pages[0]!;
  assert.equal(only.truncated, true);
  assert.ok(only.text.startsWith('GENERAL NOTES'), 'the first printed line is kept');
  assert.match(only.text, /SHEET A-900/, 'the title block at the bottom is kept too');
  assert.match(only.text, /transcript cut here/);
  assert.equal(only.sheetNumber, 'A-900');
});

test('a huge notes sheet cannot starve the later sheets of the digest', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont('Helvetica');
  const notes = doc.addPage([612, 792]);
  for (let index = 0; index < 150; index += 1) {
    notes.drawText(`${index + 1}. PROVIDE FIRE-BLOCKING AT ALL CONCEALED SPACES IN THE FRAMING.`, { x: 40, y: 770 - index * 5, size: 8, font });
  }
  const later = doc.addPage([612, 792]);
  later.drawText('DOOR AND WINDOW SCHEDULE', { x: 40, y: 750, size: 12, font });
  later.drawText('D1 HOLLOW METAL DOOR 4 EA', { x: 40, y: 730, size: 9, font });
  const sheet = await extractSheetText(await doc.save());
  const digest = describeSheetTextDigest(sheet, 6_000)!;
  assert.ok(digest.includes('DOOR AND WINDOW SCHEDULE'), 'the second sheet still reaches the provider');
  assert.ok(digest.includes('D1 HOLLOW METAL DOOR 4 EA'), 'its schedule line is not starved by the notes page');
  assert.ok(digest.length <= 6_000);
});
test('a quote whose columns are interleaved on the sheet is still located', () => {
  // Real note blocks print several columns at the same height, so the joined
  // transcript merges them and the model's quote is not one substring of it.
  const transcript = { pages: [
    { pageNumber: 1, characters: 120, text: 'FIRST FLOOR FRAMING PLAN\nJOIST HANGERS TYP. DTT ZMAX TENSION TIE\n2 x 10 @ 16" O.C. FLOOR JOISTS', truncated: false, headings: [], sheetNumber: 'S100', scale: null, likelyScanned: false },
  ] } as unknown as Parameters<typeof verifyFindingPages>[1];
  const finding = { page_number: 1, finding_type: 'material' as const, label: 'Joists', quantity: null, unit: null, value_text: null, confidence: 0.7, geometry: {}, source_excerpt: '2 x 10 @ 16" O.C. FLOOR JOISTS\nJOIST HANGERS TYP.' };
  const check = verifyFindingPages([finding as never], transcript);
  assert.equal(check.unlocated, 0, 'each quoted line is probed, so the quote is located');
  assert.equal(check.corrected, 0);
});

test('a short quoted fragment is not treated as evidence of location', () => {
  const transcript = { pages: [
    { pageNumber: 1, characters: 40, text: 'DEAD LOAD 20 PSF', truncated: false, headings: [], sheetNumber: null, scale: null, likelyScanned: false },
    { pageNumber: 2, characters: 40, text: 'LIVE LOAD 40 PSF', truncated: false, headings: [], sheetNumber: null, scale: null, likelyScanned: false },
  ] } as unknown as Parameters<typeof verifyFindingPages>[1];
  // Only 14 characters after normalization: too generic to settle a page, and it
  // is not found on page 2 either, so nothing is claimed about it.
  const check = verifyFindingPages([{ page_number: 2, finding_type: 'scope_note' as const, label: 'Load', quantity: null, unit: null, value_text: null, confidence: 0.6, geometry: {}, source_excerpt: '20 PSF' } as never], transcript);
  assert.equal(check.checked, 0);
});
