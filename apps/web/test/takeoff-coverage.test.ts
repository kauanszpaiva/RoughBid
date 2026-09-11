import test from "node:test";
import assert from "node:assert/strict";
import { summarizeTakeoffCoverage } from "../app/src/utils/takeoffCoverage.ts";

test("release remains blocked until every physical sheet and pass is accounted for", () => {
  const result = summarizeTakeoffCoverage({
    mode: "full_v2",
    releaseStatus: "released",
    sheets: [
      { physicalPageNumber: 1, status: "reviewed", passesCompleted: 10, passesTotal: 10, blockers: [] },
      { physicalPageNumber: 2, status: "review_required", passesCompleted: 8, passesTotal: 10, blockers: ["Scale requires a second check."] },
    ],
  });

  assert.deepEqual(result, {
    physicalPages: 2,
    accountedPages: 1,
    completedPasses: 18,
    totalPasses: 20,
    blockerCount: 2,
    coveragePercent: 50,
    passPercent: 90,
    canRelease: false,
  });
});

test("release is allowed only for a reconciled released run", () => {
  const result = summarizeTakeoffCoverage({
    mode: "full_v2",
    releaseStatus: "released",
    sheets: [
      { physicalPageNumber: 1, status: "reviewed", passesCompleted: 10, passesTotal: 10, blockers: [] },
      { physicalPageNumber: 2, status: "non_takeoff_informational", passesCompleted: 10, passesTotal: 10, blockers: [] },
    ],
  });

  assert.equal(result.coveragePercent, 100);
  assert.equal(result.passPercent, 100);
  assert.equal(result.canRelease, true);
});
