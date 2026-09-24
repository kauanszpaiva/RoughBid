/**
 * Builds a small synthetic construction plan set for live/provider probes.
 *
 * It is deliberately realistic in the ways the pipeline must handle: a title
 * block with a sheet number and scale, general notes with explicit quantities,
 * a floor plan with walls, rooms and areas, a schedule, and small printed
 * detail. Nothing here is a real customer document, so a probe can exercise the
 * whole pipeline against a real provider without uploading anyone's plan.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFileSync } from 'node:fs';

const INK = rgb(0.05, 0.05, 0.05);
const LIGHT = rgb(0.55, 0.55, 0.55);

function text(page: any, font: any, bold: any, value: string, x: number, y: number, size = 10, useBold = false) {
  page.drawText(value, { x, y, size, font: useBold ? bold : font, color: INK });
}

/** Every sheet carries the same title block, like a real set. */
function titleBlock(page: any, font: any, bold: any, sheet: string, name: string) {
  const width = page.getWidth();
  page.drawRectangle({ x: width - 250, y: 24, width: 226, height: 74, borderColor: INK, borderWidth: 1 });
  text(page, font, bold, 'KSP DOMINION GROUP - SAMPLE RESIDENCE', width - 242, 82, 8, true);
  text(page, font, bold, '34 MAPLE ST, MANCHESTER, NH 03101', width - 242, 70, 7);
  text(page, font, bold, `SHEET ${sheet}`, width - 242, 56, 9, true);
  text(page, font, bold, name, width - 242, 44, 8);
  text(page, font, bold, 'SCALE 1/4" = 1\'-0"', width - 242, 32, 7);
}

async function build(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // ---- A-000: cover, sheet index, general notes ----
  const cover = doc.addPage([612, 792]);
  text(cover, font, bold, 'SAMPLE RESIDENCE - CONSTRUCTION DOCUMENTS', 60, 720, 16, true);
  text(cover, font, bold, 'GENERAL NOTES', 60, 680, 12, true);
  const notes = [
    '1. PROVIDE 2x6 WOOD STUDS AT 16 INCH O.C. FOR ALL EXTERIOR WALLS.',
    '2. INSTALL 5/8 INCH TYPE X GYPSUM BOARD AT GARAGE CEILING.',
    '3. PROVIDE R-13 BATT INSULATION IN ALL EXTERIOR WALL CAVITIES.',
    '4. PROVIDE 24 LF OF KITCHEN BASE CABINET WITH 3/4 INCH PLYWOOD CASES.',
    '5. ALL INTERIOR PARTITION FRAMING SHALL BE 2x4 AT 16 INCH O.C.',
    '6. PROVIDE 5 EA EXTERIOR HOSE BIBB ASSEMBLIES.',
  ];
  notes.forEach((note, index) => text(cover, font, bold, note, 60, 655 - index * 16, 9));
  text(cover, font, bold, 'SHEET INDEX', 60, 545, 12, true);
  text(cover, font, bold, 'A-000 COVER AND GENERAL NOTES', 60, 525, 9);
  text(cover, font, bold, 'A-101 FIRST FLOOR PLAN', 60, 510, 9);
  text(cover, font, bold, 'A-601 DOOR AND WINDOW SCHEDULE', 60, 495, 9);
  titleBlock(cover, font, bold, 'A-000', 'COVER AND GENERAL NOTES');

  // ---- A-101: floor plan with walls, rooms, areas, dimensions ----
  const plan = doc.addPage([612, 792]);
  text(plan, font, bold, 'FIRST FLOOR PLAN', 60, 740, 14, true);
  // exterior shell
  plan.drawRectangle({ x: 80, y: 220, width: 420, height: 420, borderColor: INK, borderWidth: 3 });
  // interior partitions
  plan.drawLine({ start: { x: 300, y: 220 }, end: { x: 300, y: 640 }, thickness: 1.5, color: INK });
  plan.drawLine({ start: { x: 80, y: 430 }, end: { x: 300, y: 430 }, thickness: 1.5, color: INK });
  plan.drawLine({ start: { x: 420, y: 430 }, end: { x: 500, y: 430 }, thickness: 1.5, color: INK });
  // room labels with printed areas
  text(plan, font, bold, 'LIVING', 100, 560, 10, true); text(plan, font, bold, '320 SF', 100, 548, 9);
  text(plan, font, bold, 'KITCHEN', 320, 560, 10, true); text(plan, font, bold, '180 SF', 320, 548, 9);
  text(plan, font, bold, 'BEDROOM', 100, 350, 10, true); text(plan, font, bold, '144 SF', 100, 338, 9);
  text(plan, font, bold, 'BATH', 320, 350, 10, true); text(plan, font, bold, '45 SF', 320, 338, 9);
  // openings
  text(plan, font, bold, 'D1', 292, 300, 8); text(plan, font, bold, 'D2', 180, 424, 8);
  text(plan, font, bold, 'W1', 240, 646, 8); text(plan, font, bold, 'W2', 480, 500, 8);
  // overall dimension string
  text(plan, font, bold, '42\'-0"', 250, 660, 9);
  text(plan, font, bold, '28\'-0"', 40, 420, 9);
  text(plan, font, bold, 'KEYNOTES', 60, 190, 10, true);
  text(plan, font, bold, '1. HARDWOOD FLOOR AT LIVING AND BEDROOM.', 60, 176, 8);
  text(plan, font, bold, '2. CERAMIC TILE AT BATH FLOOR AND WALLS.', 60, 164, 8);
  titleBlock(plan, font, bold, 'A-101', 'FIRST FLOOR PLAN');

  // ---- A-601: door and window schedule ----
  const schedule = doc.addPage([612, 792]);
  text(schedule, font, bold, 'DOOR AND WINDOW SCHEDULE', 60, 740, 14, true);
  text(schedule, font, bold, 'MARK   SIZE              DESCRIPTION                     QTY', 60, 710, 9, true);
  const rows = [
    'D1     3\'-0" x 6\'-8"    HOLLOW METAL DOOR               4 EA',
    'D2     2\'-8" x 6\'-8"    WOOD PANEL INTERIOR DOOR        6 EA',
    'W1     4\'-0" x 4\'-0"    SLIDER WINDOW                   6 EA',
    'W2     2\'-0" x 4\'-0"    FIXED WINDOW                    4 EA',
  ];
  rows.forEach((row, index) => text(schedule, font, bold, row, 60, 690 - index * 18, 9));
  text(schedule, font, bold, 'FINISH NOTES', 60, 590, 11, true);
  text(schedule, font, bold, '1. PROVIDE 12 EA INTERIOR DOOR HARDWARE SETS BY OWNER.', 60, 574, 9);
  titleBlock(schedule, font, bold, 'A-601', 'DOOR AND WINDOW SCHEDULE');

  // ---- A-301: framing notes and small details ----
  const details = doc.addPage([612, 792]);
  text(details, font, bold, 'FRAMING NOTES AND DETAILS', 60, 740, 14, true);
  const framing = [
    '1. PROVIDE 120 LF OF 2x10 FLOOR JOISTS AT 16 INCH O.C.',
    '2. GARAGE CEILING GYPSUM: 5/8 INCH TYPE X, TAPED AND PRIMED.',
    '3. PROVIDE 18 EA JOIST HANGERS AT RIM BOARD CONNECTIONS.',
    '4. HEADERS OVER ALL OPENINGS: 2x10 DOUGLAS FIR.',
  ];
  framing.forEach((note, index) => text(details, font, bold, note, 60, 700 - index * 18, 9));
  details.drawRectangle({ x: 60, y: 480, width: 200, height: 120, borderColor: LIGHT, borderWidth: 1 });
  text(details, font, bold, 'TYPICAL WALL SECTION 1/2" = 1\'-0"', 66, 470, 8);
  titleBlock(details, font, bold, 'A-301', 'FRAMING NOTES AND DETAILS');

  return doc.save();
}

const target = process.argv[2];
if (!target) throw new Error('Output path required.');
const bytes = await build();
writeFileSync(target, bytes);
console.log(`wrote ${target} (${bytes.byteLength} bytes)`);