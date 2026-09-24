/**
 * Runs the drawing-versus-budget opening check on a real pair of files, using
 * exactly the local extraction the service uses: no provider is called.
 *
 *   node --experimental-strip-types scripts/plan-budget-conflicts.ts <drawings.pdf> <estimate.pdf>
 *
 * The drawings side supplies the rough openings; the estimate side supplies the
 * window/storefront type lines. Both are read from the PDF text layer in
 * process, so this needs no API key and costs nothing to run.
 */
import { readFileSync } from 'node:fs';
import {
  claimedWindowTypes,
  describeOpeningConflictNotice,
  drawnRoughOpenings,
  reconcileOpenings,
} from '../apps/api/src/ai-plan/drawing-conflicts.ts';
import { extractSheetText, sheetTextOptionsFromEnv } from '../apps/api/src/ai-plan/sheet-text.ts';

const [drawingsPath, estimatePath] = process.argv.slice(2);
if (!drawingsPath || !estimatePath) {
  throw new Error('Usage: plan-budget-conflicts.ts <drawings.pdf> <estimate.pdf>');
}

const options = sheetTextOptionsFromEnv(process.env);

async function transcript(path: string, label: string) {
  const bytes = new Uint8Array(readFileSync(path));
  const started = Date.now();
  const text = await extractSheetText(bytes, options);
  const truncated = text.pages.filter(page => page.truncated).map(page => page.pageNumber);
  console.log(`${label}: ${path}`);
  console.log(`  ${text.pages.length} page(s), ${text.characters} transcribed characters, ${Date.now() - started} ms`);
  if (truncated.length) console.log(`  WARNING transcript truncated inside the page budget: ${truncated.join(', ')}`);
  return text;
}

const drawings = await transcript(drawingsPath, 'drawings');
const estimate = await transcript(estimatePath, 'estimate');

const drawn = drawnRoughOpenings(drawings);
const claimed = claimedWindowTypes(estimate);
const comparison = reconcileOpenings({ drawing: drawings, document: estimate });

console.log(`\nrough openings printed on the drawings: ${drawn.length}`);
for (const entry of drawn) console.log(`  page ${entry.pageNumber}: ${(entry.inches / 12).toFixed(2)} ft (${entry.inches}")`);

const scale = (entries: readonly { widthInches: number; heightInches: number; quantity: number | null }[]) =>
  entries.reduce((sum, entry) => sum + (entry.widthInches / 12) * (entry.heightInches / 12) * (entry.quantity ?? 1), 0);

console.log(`\nwindow types priced by the estimate: ${claimed.length}`);
for (const claim of claimed) {
  const width = claim.widthInches / 12;
  const height = claim.heightInches / 12;
  const quantity = claim.quantity ?? 1;
  console.log(`  ${claim.label} ${width.toFixed(2)} x ${height.toFixed(2)} ft x ${quantity} = ${(width * height * quantity).toFixed(1)} SF   [page ${claim.pageNumber}]`);
}
console.log(`  priced window area: ${scale(claimed).toFixed(1)} SF`);

console.log(`\nconflicts: ${comparison.conflicts.length} (${comparison.matchedSizes} size(s) matched within ${comparison.toleranceInches}")`);
for (const conflict of comparison.conflicts) {
  console.log(`\n  [${conflict.code}] ${conflict.label ?? 'unlabelled'} — page ${conflict.pageNumber}`);
  console.log(`    ${conflict.detail}`);
  console.log(`    evidence: ${conflict.sourceExcerpt}`);
}

console.log(`\nlimitation line for the reading summary:\n  ${describeOpeningConflictNotice(comparison) ?? '(nothing to report)'}`);
