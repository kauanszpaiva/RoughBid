import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeReadingCoverage } from '../src/reading-coverage.ts';

const finding = (page_number: unknown, source_excerpt: unknown = 'Visible source') => ({ page_number, source_excerpt });
test('a 23-page partial reading lists every page without evidence without claiming those pages were read', () => {
  const actual = summarizeReadingCoverage({ sheet_count: 23, physical_page_count: 23 }, [5,6,7,8,13,16].map(p => finding(p)));
  assert.ok(actual);
  assert.equal(actual.totalPages, 23);
  assert.equal(actual.pageCountSource, 'pdf_preflight');
  assert.deepEqual(actual.pagesWithFindings, [5,6,7,8,13,16]);
  assert.ok(actual.pagesWithoutFindings.includes(9));
  assert.equal(actual.pagesWithoutFindings.length, 17);
  assert.equal(actual.completeTakeoffVerified, false);
  assert.equal(actual.pageReviewCoverage, 'unverified');
});
test('a model-reported page count is never called a verified PDF count', () => {
  const actual = summarizeReadingCoverage({ sheet_count: 23 }, [finding(7)]);
  assert.ok(actual);
  assert.equal(actual.pageCountSource, 'model_reported');
  assert.equal(actual.completeTakeoffVerified, false);
});
test('findings on every page do not prove exhaustive quantities or complete review', () => {
  const actual = summarizeReadingCoverage({ physical_page_count: 2, completeTakeoffVerified: true }, [finding(1),finding(2)]);
  assert.ok(actual);
  assert.deepEqual(actual.pagesWithoutFindings, []);
  assert.equal(actual.completeTakeoffVerified, false);
  assert.equal(actual.pageReviewCoverage, 'unverified');
});
test('counts only unique physical pages with nonempty source citations', () => {
  const actual = summarizeReadingCoverage({ physical_page_count: 3 }, [finding(1),finding(1),finding(2,''),finding(3,'  '),finding(4),finding(0),finding('2'),finding(1.5),null]);
  assert.ok(actual);
  assert.deepEqual(actual.pagesWithFindings, [1]);
  assert.deepEqual(actual.pagesWithoutFindings, [2,3]);
});
test('missing or corrupt counts stay unknown rather than becoming 100 percent', () => {
  for (const summary of [null, {}, {sheet_count: '23'}, {physical_page_count: -1}, {sheet_count: 1e12}, {sheet_count: Infinity}]) {
    const actual = summarizeReadingCoverage(summary, [finding(9)]);
    assert.ok(actual);
    assert.equal(actual.totalPages, null);
    assert.equal(actual.pageCountSource, 'unknown');
    assert.equal(actual.completeTakeoffVerified, false);
  }
});
test('deterministic PDF count takes precedence over the model and preserves source values', () => {
  const input = { physical_page_count: 23, sheet_count: 1 };
  const actual = summarizeReadingCoverage(input, [finding(23)]);
  assert.ok(actual);
  assert.equal(actual.totalPages, 23);
  assert.deepEqual(input, {physical_page_count:23,sheet_count:1});
});
