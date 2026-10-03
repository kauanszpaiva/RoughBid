import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateServiceScope, splitEstimateFiles } from '../app/src/utils/estimateIntake.ts';

test('one selection accepts plans, photos and a mixed batch and infers missing browser MIME types', () => {
  const plan = new File(['%PDF-1.7'], 'room.PDF');
  const photo = new File(['image'], 'room.jpg', { type: 'image/jpeg' });
  const mixed = splitEstimateFiles([plan, photo]);
  assert.equal(mixed.plans[0]!.type, 'application/pdf');
  assert.equal(mixed.photos[0], photo);
  assert.equal(splitEstimateFiles([plan]).photos.length, 0);
  assert.equal(splitEstimateFiles([photo]).plans.length, 0);
});

test('mixed selection rejects unsupported or mislabeled sources and aggregate limits before upload', () => {
  const valid = new File(['image'], 'one.png', { type: 'image/png' });
  assert.throws(() => splitEstimateFiles([valid, new File(['heic'], 'two.heic')]), /JPEG/);
  assert.throws(() => splitEstimateFiles([new File(['text'], 'renamed.pdf', { type: 'text/plain' })]), /use PDF/);
  assert.throws(() => splitEstimateFiles([]), /Add photos/);
  assert.throws(() => splitEstimateFiles(Array.from({ length: 9 }, () => valid)), /eight photos/);
  const large = new File([new Uint8Array(15 * 1024 * 1024)], 'large.png', { type: 'image/png' });
  assert.throws(() => splitEstimateFiles([large, large, large]), /40 MB/);
});

test('selected services preserve exact estimating scope without duplicating a shared provider trade', () => {
  assert.deepEqual(estimateServiceScope(['tile', 'painting', 'framing']), { trades: ['Finishes', 'Framing'], scope: 'Tile, Painting, Framing' });
  assert.throws(() => estimateServiceScope([]), /Choose/);
  assert.throws(() => estimateServiceScope(['tile', 'not-a-service']), /supported/);
});
