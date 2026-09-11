/** Evidence-page coverage is not a measure of extraction accuracy or review completeness. */
export interface ReadingCoverage {
  version: 'page-evidence-v1';
  totalPages: number | null;
  pageCountSource: 'pdf_preflight' | 'model_reported' | 'unknown';
  pagesWithFindings: number[];
  pagesWithoutFindings: number[];
  pageReviewCoverage: 'unverified';
  completeTakeoffVerified: false;
}
const validCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 10_000;

/** Only pass trusted stored/preflight metadata here; model coverage assertions are ignored. */
export function summarizeReadingCoverage(summary: unknown, findings: readonly unknown[]): ReadingCoverage {
  const record = summary && typeof summary === 'object' && !Array.isArray(summary)
    ? summary as Record<string, unknown> : {};
  const physical = validCount(record.physical_page_count) ? record.physical_page_count : null;
  const reported = validCount(record.sheet_count) ? record.sheet_count : null;
  const totalPages = physical ?? reported;
  const pagesWithFindings = [...new Set(findings.flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const finding = value as Record<string, unknown>;
    const page = finding.page_number;
    if (!validCount(page) || (totalPages !== null && page > totalPages)
      || typeof finding.source_excerpt !== 'string' || !finding.source_excerpt.trim()) return [];
    return [page];
  }))].sort((a,b) => a-b);
  const cited = new Set(pagesWithFindings);
  return {
    version: 'page-evidence-v1', totalPages,
    pageCountSource: physical !== null ? 'pdf_preflight' : reported !== null ? 'model_reported' : 'unknown',
    pagesWithFindings,
    pagesWithoutFindings: totalPages === null ? [] : Array.from({length: totalPages}, (_,i) => i+1).filter(page => !cited.has(page)),
    pageReviewCoverage: 'unverified', completeTakeoffVerified: false,
  };
}

export const INCOMPLETE_TAKEOFF_NOTICE = 'Complete takeoff coverage is not verified. Saved findings are a partial extraction, not proof that every sheet, room, wall, opening or material was accounted for.';
