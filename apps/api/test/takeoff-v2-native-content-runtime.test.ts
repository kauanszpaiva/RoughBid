import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { analyzePdfNativeContent } from '../src/takeoff-v2/native-content.ts';

test('PDF.js runtime detects native text from a real generated vector PDF', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('A1.1 FLOOR PLAN SCALE 1/4 IN = 1 FT', { x: 72, y: 720, size: 12, font });
  page.drawLine({ start: { x: 72, y: 650 }, end: { x: 360, y: 650 }, thickness: 1 });
  const bytes = new Uint8Array(await pdf.save({ useObjectStreams: false }));

  const analysis = await analyzePdfNativeContent(bytes);
  assert.equal(analysis.size, 1);
  const first = analysis.get(1);
  assert.ok(first);
  assert.equal(first.contentKind, 'vector');
  assert.equal(first.textQuality, 'partial');
  assert.ok(first.textCharacters >= 10, `expected native text characters, got ${first.textCharacters}`);
});

test('native-content runtime rejects empty input before loading PDF.js', async () => {
  await assert.rejects(() => analyzePdfNativeContent(new Uint8Array()), /non-empty PDF/i);
});
