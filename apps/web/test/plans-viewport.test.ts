import test from 'node:test';
import assert from 'node:assert/strict';
import { clampZoom, computeBoxFocusZoom, computeFitPageZoom, computeFitWidthZoom, getContinuousRenderWindow, pickActivePage } from '../app/src/features/plans/utils/viewport.ts';

test('zoom clamps to 25-500 percent', () => {
  assert.equal(clampZoom(5), 25);
  assert.equal(clampZoom(125), 125);
  assert.equal(clampZoom(900), 500);
});

test('fit calculations use total viewport padding', () => {
  assert.equal(computeFitWidthZoom({ pageWidth: 1000, viewportWidth: 800, totalHorizontalPadding: 40 }), 76);
  assert.equal(computeFitPageZoom({ pageWidth: 1000, pageHeight: 800, viewportWidth: 800, viewportHeight: 600, totalHorizontalPadding: 40, totalVerticalPadding: 40 }), 70);
});

test('box focus targets 72 percent of viewport and clamps', () => {
  assert.equal(computeBoxFocusZoom({ boxWidth: 0.5, boxHeight: 0.5, currentZoom: 100 }), 144);
  assert.equal(computeBoxFocusZoom({ boxWidth: 0.01, boxHeight: 0.01, currentZoom: 100 }), 500);
});

test('continuous render window is bounded around active page', () => {
  assert.deepEqual(getContinuousRenderWindow({ activePage: 10, totalPages: 50, radius: 2 }), [8, 9, 10, 11, 12]);
  assert.deepEqual(getContinuousRenderWindow({ activePage: 1, totalPages: 3, radius: 2 }), [1, 2, 3]);
});

test('largest intersection ratio selects active page', () => {
  assert.equal(pickActivePage([{ page: 4, ratio: 0.2 }, { page: 5, ratio: 0.8 }, { page: 6, ratio: 0.3 }]), 5);
});
