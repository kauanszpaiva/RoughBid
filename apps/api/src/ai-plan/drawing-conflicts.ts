/**
 * Drawing-versus-document conflict check.
 *
 * A cost estimate is internally consistent and still wrong: the North
 * Elementary School design-development estimate sums to 2,467 SF of
 * window/storefront — exactly the total of the window types printed in its own
 * line items — while the drawings it was prepared from print 17'-8 1/2" and
 * 17'-9" for two of those types and never print the 11'-8 1/2" it priced. Three
 * window types were under-measured by about 146 SF, roughly 5.9% of the largest
 * trade line, and nothing in the estimate gave that away.
 *
 * This module compares a document that *claims* sized openings (an imported
 * estimate or budget) against the dimensions the drawings *print*, and reports
 * every disagreement with the sheet it came from. It is deterministic, local and
 * needs no provider: both sides are text already extracted from the PDFs.
 *
 * Both sides are read from the bounded transcript, so a page truncated inside
 * the per-page character budget can hide a line and make a size look missing.
 * The caller should surface that truncation next to the result rather than let
 * an empty page read as agreement; `scripts/plan-budget-conflicts.ts` does.
 *
 * What it checks, and what it deliberately does not:
 * - It reads rough-opening dimensions, which drawings mark with `R.O.` — that
 *   marker is what makes a printed size attributable to a window or storefront
 *   opening rather than to a wall, a room or a detail.
 * - It compares **window and storefront type lines** only. Door sizes live in a
 *   schedule table without an `R.O.` marker, and door lines in an estimate
 *   routinely carry two alternative sizes and pairs instead of units, so
 *   comparing them here would manufacture disagreements.
 * - Matching is by size, within a tolerance, not by type label: it can say that
 *   the width a document prices is not drawn anywhere, but it cannot yet say
 *   which drawn opening the document meant. Every conflict states exactly that
 *   much and no more.
 * - Only `R.O.`-marked sizes are treated as drawn evidence, so a size the
 *   drawings print without that marker — as a chain of dimensions, or only in a
 *   schedule table — reads as not drawn. On the reference pair that is one of
 *   five flags, a half-inch difference an estimator dismisses in seconds; the
 *   alternative would be to suppress the flags that matter. Associating each
 *   drawn size with its type label needs the text item positions, which this
 *   module does not read yet.
 *
 * Nothing here prices anything, and nothing here changes a quantity. A conflict
 * is evidence for a human to resolve.
 */
import type { SheetText } from './sheet-text.ts';

/** Half an inch: drawings round rough openings, and estimates round again. */
export const DEFAULT_DIMENSION_TOLERANCE_INCHES = 0.5;
export const MAX_OPENING_CONFLICTS = 40;
const MAX_EXCERPT_CHARACTERS = 200;
const MAX_CLAIMED_TYPES = 200;
const MAX_DRAWN_DIMENSIONS = 400;

export interface OpeningClaim {
  /** Type label as printed, e.g. "D", "A1", "B1-AC". */
  label: string;
  widthInches: number;
  heightInches: number;
  quantity: number | null;
  unit: string | null;
  pageNumber: number;
  sourceExcerpt: string;
}

export interface DrawnDimension {
  inches: number;
  pageNumber: number;
  sourceExcerpt: string;
}

export type OpeningConflictCode =
  /** The document prices a size the drawings never print as a rough opening. */
  | 'claimed_width_not_drawn'
  | 'claimed_height_not_drawn'
  /** The drawings print a rough-opening size the document prices nowhere. */
  | 'drawn_size_not_claimed';

export interface OpeningConflict {
  code: OpeningConflictCode;
  label: string | null;
  inches: number;
  /** One sentence a reviewer can act on, naming both sides of the disagreement. */
  detail: string;
  pageNumber: number;
  sourceExcerpt: string;
}

export interface OpeningComparison {
  conflicts: OpeningConflict[];
  claimedChecked: number;
  drawnChecked: number;
  matchedSizes: number;
  toleranceInches: number;
}

/** Text-only view of a page, so a caller with an untruncated transcript can use this. */
export interface TranscriptPage {
  pageNumber: number;
  text: string;
  truncated?: boolean;
}

export interface TranscriptLike {
  pages: readonly TranscriptPage[];
}

function excerpt(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_EXCERPT_CHARACTERS);
}

/**
 * Evidence for one match inside a page's transcript. A page's printed rows do
 * not always carry line ends — an estimate exported from a spreadsheet can
 * arrive as a single very long line — so the excerpt is a window around the
 * match rather than the whole line.
 */
function windowAround(text: string, index: number, length: number, trailing = 40): string {
  return excerpt(text.slice(Math.max(0, index - 30), Math.min(text.length, index + length + trailing)));
}

/** `11'-8 1/2"` and `8' - 0"` and bare `8'-2"` become inches. */
export function parseFeetInchesToInches(value: string): number | null {
  const match = /^(\d{1,3})\s*'\s*-\s*(\d{1,2})(?:\s+(\d{1,2})\s*\/\s*(\d{1,2}))?\s*"?$/.exec(value.trim());
  if (!match) return null;
  const feet = Number(match[1]);
  const inches = Number(match[2]);
  const numerator = match[3] === undefined ? 0 : Number(match[3]);
  const denominator = match[4] === undefined ? 1 : Number(match[4]);
  if (!Number.isSafeInteger(feet) || !Number.isSafeInteger(inches)) return null;
  if (inches > 11 || !Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator === 0) return null;
  if (numerator >= denominator) return null;
  return feet * 12 + inches + numerator / denominator;
}

/** Inches back to the feet-and-inches a drawing would print, for readable details. */
export function formatInchesAsFeetInches(value: number): string {
  const whole = Math.floor(value);
  const feet = Math.floor(whole / 12);
  const inches = whole % 12;
  const fraction = value - whole;
  const fractions: Array<[number, string]> = [[0.5, '1/2'], [0.25, '1/4'], [0.75, '3/4'], [0.125, '1/8'], [0.375, '3/8'], [0.625, '5/8'], [0.875, '7/8']];
  const suffix = fractions.find(([size, text]) => Math.abs(fraction - size) < 0.001)?.[1] ?? '';
  return `${feet}'-${inches}${suffix ? ` ${suffix}` : ''}"`;
}

const FEET_INCHES = String.raw`\d{1,3}\s*'\s*-\s*\d{1,2}(?:\s+\d{1,2}\s*\/\s*\d{1,2})?"`;

/**
 * Window/storefront type lines in an estimate or budget:
 * `Window type D; 11'-8 1/2" x 8'-0"  1 ea  3,100.00  3,100`.
 * A type group such as `Window type A1/A2/A1-AC` is one line describing three
 * types of the same size, so the label keeps its slashes. A line that prints
 * more than one alternative size (`5'-7" / 5'-8 1/2" x 7'-0"`) is skipped rather
 * than guessed at.
 */
const CLAIM_PATTERN = new RegExp(
  String.raw`\b(?:window|storefront)\s+type\s+([A-Za-z0-9][A-Za-z0-9/-]{0,23})\s*[:;]?\s*(${FEET_INCHES})\s*(?:x|\u00d7)\s*(${FEET_INCHES})`,
  'gi',
);
const QUANTITY_PATTERN = /\b(\d{1,6}(?:,\d{3})*(?:\.\d+)?)\s*(ea|pr|sf|lf|cy|sy|hr|ls|unit|units)\b/i;
const ROUGH_OPENING_PATTERN = new RegExp(String.raw`(${FEET_INCHES})\s*(?:\+\s*\/\s*-|\+\/-)?\s*(?:R\.\s*O\.|ROUGH\s+OPENING)`, 'gi');

/** Reads the window/storefront type lines a document claims, with their evidence. */
export function claimedWindowTypes(transcript: TranscriptLike | SheetText | undefined): OpeningClaim[] {
  if (!transcript?.pages) return [];
  const claims: OpeningClaim[] = [];
  const seen = new Set<string>();
  for (const page of transcript.pages) {
    CLAIM_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CLAIM_PATTERN.exec(page.text)) !== null) {
      if (claims.length >= MAX_CLAIMED_TYPES) return claims;
      const widthInches = parseFeetInchesToInches(match[2]!);
      const heightInches = parseFeetInchesToInches(match[3]!);
      if (widthInches === null || heightInches === null) continue;
      const label = match[1]!.toUpperCase();
      // The same type priced twice is one fact; keep the first sheet that said it.
      const key = `${label}|${widthInches.toFixed(2)}|${heightInches.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const tail = page.text.slice(match.index + match[0].length, match.index + match[0].length + 80);
      const quantity = QUANTITY_PATTERN.exec(tail);
      const parsedQuantity = quantity ? Number(quantity[1]!.replace(/,/g, '')) : null;
      claims.push({
        label,
        widthInches,
        heightInches,
        quantity: parsedQuantity !== null && Number.isFinite(parsedQuantity) ? parsedQuantity : null,
        unit: quantity ? quantity[2]!.toLowerCase() : null,
        pageNumber: page.pageNumber,
        sourceExcerpt: windowAround(page.text, match.index, match[0].length, 40),
      });
    }
  }
  return claims;
}

/** Reads every rough-opening dimension the drawings print, with its sheet. */
export function drawnRoughOpenings(transcript: TranscriptLike | SheetText | undefined): DrawnDimension[] {
  if (!transcript?.pages) return [];
  const drawn: DrawnDimension[] = [];
  const seen = new Set<string>();
  for (const page of transcript.pages) {
    ROUGH_OPENING_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ROUGH_OPENING_PATTERN.exec(page.text)) !== null) {
      if (drawn.length >= MAX_DRAWN_DIMENSIONS) return drawn;
      const inches = parseFeetInchesToInches(match[1]!);
      if (inches === null || inches <= 0) continue;
      // One drawn size is one fact; a size printed on five sheets is still one fact.
      const key = inches.toFixed(2);
      if (seen.has(key)) continue;
      seen.add(key);
      drawn.push({ inches, pageNumber: page.pageNumber, sourceExcerpt: windowAround(page.text, match.index, match[0].length, 10) });
    }
  }
  return drawn;
}

const near = (a: number, b: number, tolerance: number): boolean => Math.abs(a - b) <= tolerance;

/**
 * Compares claimed window sizes against drawn rough openings. A size that is
 * claimed but not drawn, or drawn but never claimed, is reported; a size both
 * sides agree on is counted as matched and stays silent.
 */
export function compareWindowTypes(input: {
  claimed: readonly OpeningClaim[];
  drawn: readonly DrawnDimension[];
  toleranceInches?: number;
  maxConflicts?: number;
}): OpeningComparison {
  const toleranceInches = Number.isFinite(input.toleranceInches) && (input.toleranceInches as number) >= 0
    ? (input.toleranceInches as number)
    : DEFAULT_DIMENSION_TOLERANCE_INCHES;
  const maxConflicts = Math.max(1, Math.min(input.maxConflicts ?? MAX_OPENING_CONFLICTS, MAX_OPENING_CONFLICTS));
  const conflicts: OpeningConflict[] = [];
  const matchedDrawn = new Set<number>();

  // An empty side is not evidence of absence. Without priced types there is
  // nothing to check, and without drawn rough openings every priced size would
  // look missing — which would report agreement as a page of conflicts.
  if (!input.claimed.length || !input.drawn.length) {
    return {
      conflicts,
      claimedChecked: input.claimed.length,
      drawnChecked: input.drawn.length,
      matchedSizes: 0,
      toleranceInches,
    };
  }

  for (const claim of input.claimed) {
    if (conflicts.length >= maxConflicts) break;
    const widthMatch = input.drawn.find(dimension => near(dimension.inches, claim.widthInches, toleranceInches));
    const heightMatch = input.drawn.find(dimension => near(dimension.inches, claim.heightInches, toleranceInches));
    if (widthMatch) matchedDrawn.add(widthMatch.inches);
    if (heightMatch) matchedDrawn.add(heightMatch.inches);
    if (!widthMatch) {
      conflicts.push({
        code: 'claimed_width_not_drawn',
        label: claim.label,
        inches: claim.widthInches,
        detail: `Window type ${claim.label} is priced at ${formatInchesAsFeetInches(claim.widthInches)} wide, and the drawings print no rough opening that width.`,
        pageNumber: claim.pageNumber,
        sourceExcerpt: claim.sourceExcerpt,
      });
    }
    if (!heightMatch) {
      conflicts.push({
        code: 'claimed_height_not_drawn',
        label: claim.label,
        inches: claim.heightInches,
        detail: `Window type ${claim.label} is priced at ${formatInchesAsFeetInches(claim.heightInches)} high, and the drawings print no rough opening that height.`,
        pageNumber: claim.pageNumber,
        sourceExcerpt: claim.sourceExcerpt,
      });
    }
  }

  for (const dimension of input.drawn) {
    if (conflicts.length >= maxConflicts) break;
    if (matchedDrawn.has(dimension.inches)) continue;
    const claimedNear = input.claimed.some(claim =>
      near(claim.widthInches, dimension.inches, toleranceInches) || near(claim.heightInches, dimension.inches, toleranceInches));
    if (claimedNear) continue;
    const size = formatInchesAsFeetInches(dimension.inches);
    const neighbours = input.drawn.filter(other => other.inches !== dimension.inches && near(other.inches, dimension.inches, 6))
      .map(other => formatInchesAsFeetInches(other.inches));
    conflicts.push({
      code: 'drawn_size_not_claimed',
      label: null,
      inches: dimension.inches,
      detail: `The drawings print a ${size} rough opening that no priced type matches${neighbours.length ? ` (${neighbours.join(', ')} is drawn nearby)` : ''}.`,
      pageNumber: dimension.pageNumber,
      sourceExcerpt: dimension.sourceExcerpt,
    });
  }

  return {
    conflicts,
    claimedChecked: input.claimed.length,
    drawnChecked: input.drawn.length,
    matchedSizes: matchedDrawn.size,
    toleranceInches,
  };
}

/**
 * Runs the whole check over a drawing transcript and a document transcript, in
 * whichever order the caller has them.
 */
export function reconcileOpenings(input: {
  drawing: TranscriptLike | SheetText | undefined;
  document: TranscriptLike | SheetText | undefined;
  toleranceInches?: number;
}): OpeningComparison {
  return compareWindowTypes({
    claimed: claimedWindowTypes(input.document),
    drawn: drawnRoughOpenings(input.drawing),
    ...(input.toleranceInches === undefined ? {} : { toleranceInches: input.toleranceInches }),
  });
}

/** Honest coverage line for `summary.limitations`: silence must mean agreement. */
export function describeOpeningConflictNotice(comparison: OpeningComparison | undefined): string | null {
  if (!comparison) return null;
  if (!comparison.claimedChecked || !comparison.drawnChecked) return null;
  if (!comparison.conflicts.length) {
    return `Every one of the ${comparison.claimedChecked} priced window type(s) matches a rough opening printed on the drawings, within ${comparison.toleranceInches}".`;
  }
  return `${comparison.conflicts.length} disagreement(s) between the priced window types and the rough openings printed on the drawings (${comparison.matchedSizes} size(s) matched within ${comparison.toleranceInches}"). Each is listed with its sheet and must be resolved by an estimator before the quantities are trusted.`;
}
