export type TakeoffSheetCoverageStatus =
  | "reviewed"
  | "non_takeoff_informational"
  | "superseded"
  | "duplicate"
  | "unreadable"
  | "blocked"
  | "review_required";

export type TakeoffSheetCoverage = {
  physicalPageNumber: number;
  status: TakeoffSheetCoverageStatus;
  passesCompleted: number;
  passesTotal: number;
  blockers: string[];
};

export type TakeoffV2Coverage = {
  mode: "full_v2";
  sheets: TakeoffSheetCoverage[];
  releaseStatus: "blocked" | "review_ready" | "released";
};

export type TakeoffCoverageMetrics = {
  physicalPages: number;
  accountedPages: number;
  completedPasses: number;
  totalPasses: number;
  blockerCount: number;
  coveragePercent: number;
  passPercent: number;
  canRelease: boolean;
};

const ACCOUNTED_STATUSES = new Set<TakeoffSheetCoverageStatus>([
  "reviewed",
  "non_takeoff_informational",
  "superseded",
  "duplicate",
]);

export function summarizeTakeoffCoverage(coverage: TakeoffV2Coverage): TakeoffCoverageMetrics {
  let accountedPages = 0;
  let completedPasses = 0;
  let totalPasses = 0;
  let blockerCount = 0;

  for (const sheet of coverage.sheets) {
    if (ACCOUNTED_STATUSES.has(sheet.status)) accountedPages += 1;
    completedPasses += Math.max(0, Math.min(sheet.passesCompleted, sheet.passesTotal));
    totalPasses += Math.max(0, sheet.passesTotal);
    blockerCount += sheet.blockers.length;
    if (sheet.status === "blocked" || sheet.status === "unreadable" || sheet.status === "review_required") {
      blockerCount += 1;
    }
  }

  const physicalPages = coverage.sheets.length;
  const coveragePercent = physicalPages === 0 ? 0 : Math.round((accountedPages / physicalPages) * 100);
  const passPercent = totalPasses === 0 ? 0 : Math.round((completedPasses / totalPasses) * 100);
  const canRelease =
    coverage.releaseStatus === "released"
    && physicalPages > 0
    && accountedPages === physicalPages
    && completedPasses === totalPasses
    && blockerCount === 0;

  return { physicalPages, accountedPages, completedPasses, totalPasses, blockerCount, coveragePercent, passPercent, canRelease };
}
