import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LINEWORK_MAX_PAGES,
  DEFAULT_LINEWORK_MAX_SEGMENTS_PER_PAGE,
  MAX_LINEWORK_MAX_PAGES,
  MAX_LINEWORK_MAX_SEGMENTS_PER_PAGE,
  describeLineworkCoverageNotice,
  lineworkOptionsFromEnv,
  mergeLineworkFindings,
  type DrawingLinework,
  type PageLinework,
} from '../src/ai-plan/drawing-linework.ts';
import {
  DEFAULT_SHEET_TEXT_MAX_PAGES,
  describeSheetTextCoverageNotice,
  type SheetText,
} from '../src/ai-plan/sheet-text.ts';

function page(pageNumber: number, regions: number): PageLinework {
  return {
    pageNumber, pageWidthPoints: 612, pageHeightPoints: 792, rotationDegrees: 0,
    paths: 1, segments: regions, curvedSegments: 0, strokedPaths: 1, filledPaths: 0,
    clippedPaths: 0, totalLengthPoints: 10,
    horizontal: { count: 1, totalLengthPoints: 10, longestPoints: 10 },
    vertical: { count: 1, totalLengthPoints: 10, longestPoints: 10 },
    diagonal: { count: 0, totalLengthPoints: 0, longestPoints: 0 },
    wallLikeSegments: 2,
    regions: Array.from({ length: regions }, (_, index) => ({
      bbox: [0.1, 0.1 + index / 100, 0.2, 0.2] as [number, number, number, number],
      widthPoints: 80, heightPoints: 60, vertices: 4, areaPoints2: 4800 - index,
    })),
    truncated: false,
  };
}

const linework = (pages: PageLinework[], truncated: boolean, pageLimit: number, segmentLimitedPages: number[] = []): DrawingLinework => ({
  pages, pageLimit, pageLimitReached: truncated && !segmentLimitedPages.length, segmentLimitedPages, truncated,
});

test('the linework page limit covers a whole supported set and stays bounded', () => {
  // The product accepts at most 100 physical pages, so the default must not stop earlier.
  assert.equal(DEFAULT_LINEWORK_MAX_PAGES, 100);
  assert.equal(MAX_LINEWORK_MAX_PAGES, 200);
  assert.deepEqual(lineworkOptionsFromEnv({}), { maxPages: 100, maxSegmentsPerPage: DEFAULT_LINEWORK_MAX_SEGMENTS_PER_PAGE });
  assert.deepEqual(lineworkOptionsFromEnv({ AI_PLAN_LINEWORK_MAX_PAGES: '12' }), { maxPages: 12, maxSegmentsPerPage: DEFAULT_LINEWORK_MAX_SEGMENTS_PER_PAGE });
  // A nonsensical or oversized value falls back, never widens past the ceiling.
  for (const value of ['0', '-3', 'abc', '']) {
    assert.deepEqual(lineworkOptionsFromEnv({ AI_PLAN_LINEWORK_MAX_PAGES: value }), { maxPages: 100, maxSegmentsPerPage: DEFAULT_LINEWORK_MAX_SEGMENTS_PER_PAGE }, value);
  }
  assert.deepEqual(lineworkOptionsFromEnv({ AI_PLAN_LINEWORK_MAX_PAGES: '9999' }), { maxPages: 200, maxSegmentsPerPage: DEFAULT_LINEWORK_MAX_SEGMENTS_PER_PAGE });
  assert.deepEqual(
    lineworkOptionsFromEnv({ AI_PLAN_LINEWORK_MAX_SEGMENTS_PER_PAGE: '4000' }),
    { maxPages: 100, maxSegmentsPerPage: 4000 },
  );
  assert.equal(lineworkOptionsFromEnv({ AI_PLAN_LINEWORK_MAX_SEGMENTS_PER_PAGE: '99999999' }).maxSegmentsPerPage, MAX_LINEWORK_MAX_SEGMENTS_PER_PAGE);
  assert.equal(lineworkOptionsFromEnv({ AI_PLAN_LINEWORK_MAX_SEGMENTS_PER_PAGE: 'nope' }).maxSegmentsPerPage, DEFAULT_LINEWORK_MAX_SEGMENTS_PER_PAGE);
});

test('a saturated sheet is disclosed as that sheet, never as later sheets having no linework', () => {
  // Measured on a real 19-page school set: 20,000 segments per page cut the four
  // densest sheets (the demolition and floor plans holding every door and window
  // tag) while every sheet was in fact read. The notice used to claim the
  // opposite — that later sheets carried no measured lines at all.
  const saturated = linework([page(6, 2), page(7, 2)], true, 100, [6, 7]);
  const notice = describeLineworkCoverageNotice(saturated, 19)!;
  assert.match(notice, /per-page segment limit/i);
  assert.match(notice, /2 sheet\(s\)/);
  assert.match(notice, /physical page 6, 7/);
  assert.match(notice, /every other sheet was measured in full/i);
  assert.doesNotMatch(notice, /later sheets have no locally measured lines/i);

  // Both causes at once: each is still reported on its own terms.
  const both: DrawingLinework = { pages: [page(1, 1)], pageLimit: 3, pageLimitReached: true, segmentLimitedPages: [2], truncated: true };
  const bothNotice = describeLineworkCoverageNotice(both, 10)!;
  assert.match(bothNotice, /at most 3 of 10 physical pages/);
  assert.match(bothNotice, /physical page 2/);
});

test('an incomplete linework pass is disclosed in the saved reading, not only to the model', () => {
  assert.equal(describeLineworkCoverageNotice(undefined), null);
  assert.equal(describeLineworkCoverageNotice(linework([page(1, 1)], false, 100)), null);
  assert.equal(describeLineworkCoverageNotice(linework([page(1, 1)], false, 100), 60), null);

  const truncated = linework([page(1, 1)], true, 24);
  assert.match(describeLineworkCoverageNotice(truncated, 60)!, /at most 24 of 60 physical pages/);
  assert.match(describeLineworkCoverageNotice(truncated, 60)!, /no locally measured lines, wall runs or closed outlines/i);
  // Without an authorized page count the notice still names what was measured.
  assert.match(describeLineworkCoverageNotice(truncated)!, /at most 24 physical pages/);
  assert.doesNotMatch(describeLineworkCoverageNotice(truncated)!, /of 24/);
});

test('an incomplete text transcript is disclosed in the saved reading too', () => {
  const complete = { pages: [], pageLimit: DEFAULT_SHEET_TEXT_MAX_PAGES, characterLimit: 30_000, characters: 0, truncated: false } satisfies SheetText;
  assert.equal(describeSheetTextCoverageNotice(complete), null);
  const truncated = { ...complete, pageLimit: 80, truncated: true } satisfies SheetText;
  assert.match(describeSheetTextCoverageNotice(truncated, 100)!, /at most 80 of 100 physical pages/);
  assert.match(describeSheetTextCoverageNotice(truncated, 100)!, /not checked against the PDF text/i);
});

test('a capped outline list says how many were detected in total', () => {
  const many = linework([page(1, 3)], false, 100);
  const capped = mergeLineworkFindings([], many, { maxFindings: 1 });
  assert.equal(capped.added, 1);
  assert.match(capped.note!, /closed outline\(s\) were added as unlabeled geometry evidence/);
  assert.match(capped.note!, /3 closed outline\(s\) were detected in total/);

  const all = mergeLineworkFindings([], linework([page(1, 1)], false, 100));
  assert.equal(all.added, 1);
  assert.doesNotMatch(all.note!, /were detected in total/);
});
