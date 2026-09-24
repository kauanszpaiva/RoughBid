/**
 * Live probe: runs the real production Gemini reader (PDF-native) against a real
 * PDF, with exactly the local evidence the service builds.
 *
 *   GEMINI_API_KEY=... GEMINI_MODEL=gemini-3.8-flash \
 *     node --experimental-strip-types scripts/live-gemini-plan-reading-probe.ts <plan.pdf> [--out file.json]
 *
 * The key is read from the environment and never printed. This script talks to
 * the provider directly, so it bypasses the database: it is a reading-quality
 * probe, not a spend-breaker test. The company spend breaker is exercised only
 * by the service path (`AiPlanReadingService`). Use
 * `scripts/live-plan-reading-probe.ts` for the metered OpenAI sweep.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createGeminiClient, GeminiPlanReader } from '../apps/api/src/ai-plan/gemini.ts';
import { extractDrawingLinework, lineworkOptionsFromEnv, vectorLineworkEnabled } from '../apps/api/src/ai-plan/drawing-linework.ts';
import { extractSheetText, sheetTextOptionsFromEnv, sheetTextEnabled, verifyFindingPages } from '../apps/api/src/ai-plan/sheet-text.ts';
import { countPdfPages } from '../apps/api/src/ai-plan/plan-batches.ts';

const [planPath, ...rest] = process.argv.slice(2);
if (!planPath) throw new Error('Usage: live-gemini-plan-reading-probe.ts <plan.pdf> [--out file.json] [--trades a,b] [--scope text]');
const outFlag = rest.indexOf('--out');
const tradesFlag = rest.indexOf('--trades');
const scopeFlag = rest.indexOf('--scope');
const outPath = outFlag >= 0 ? rest[outFlag + 1] : null;
const trades = tradesFlag >= 0
  ? rest[tradesFlag + 1]!.split(',').map(value => value.trim()).filter(Boolean)
  : ['Framing', 'Concrete', 'Drywall', 'Electrical', 'Plumbing', 'HVAC', 'Finishes'];
const scope = scopeFlag >= 0 ? rest[scopeFlag + 1]! : 'Full takeoff of the supplied set.';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('GEMINI_API_KEY is required in the environment.');
const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

const bytes = new Uint8Array(readFileSync(planPath));
const pageCount = await countPdfPages(bytes);
console.log(`plan: ${planPath} (${bytes.byteLength} bytes, ${pageCount} pages)`);
console.log(`model: ${model} | api key: ${apiKey.length} chars (not printed)`);

const localStarted = Date.now();
const linework = vectorLineworkEnabled(process.env) ? await extractDrawingLinework(bytes, lineworkOptionsFromEnv(process.env)) : undefined;
const sheetText = sheetTextEnabled(process.env) ? await extractSheetText(bytes, sheetTextOptionsFromEnv(process.env)) : undefined;
console.log(`local evidence: ${Date.now() - localStarted} ms | linework pages ${linework?.pages.length ?? 0}/${pageCount} | text pages ${sheetText?.pages.length ?? 0} | transcript ${sheetText?.characters ?? 0} chars`);
if (linework) {
  const strokes = linework.pages.reduce((sum, page) => sum + page.vertical.count + page.horizontal.count, 0);
  const regions = linework.pages.reduce((sum, page) => sum + page.regions.length, 0);
  console.log(`  measured drawing: ${strokes} wall-like strokes, ${regions} closed region(s)`);
}

const reader = new GeminiPlanReader(await createGeminiClient(apiKey), [model]);
const started = Date.now();
const reading = await reader.read({
  fileBytes: bytes,
  mimeType: 'application/pdf',
  sheetName: planPath.split(/[\\/]/).pop()!,
  requestedTrades: trades,
  scope,
  ...(linework ? { linework } : {}),
  ...(sheetText ? { sheetText } : {}),
  pageCount,
});
console.log(`provider: ${((Date.now() - started) / 1000).toFixed(1)} s`);

// The same post-processing the service applies to every reading.
const citation = verifyFindingPages(reading.findings, sheetText);
reading.findings = citation.findings;
console.log(`citation check: ${citation.checked} checked | ${citation.corrected} page(s) corrected from the local transcript | ${citation.unlocated} unlocated`);

console.log(`\nsheet_count: ${reading.summary.sheet_count} | trades: ${reading.summary.detected_trade_scope.join(', ') || '-'} | scale: ${reading.summary.scale_status}`);
if (reading.summary.project_address) {
  const address = reading.summary.project_address;
  console.log(`address: ${[address.street_address, address.city, address.state, address.postal_code].filter(Boolean).join(', ')} (page ${address.page_number})`);
}
console.log(`findings: ${reading.findings.length}`);
for (const finding of reading.findings) {
  const quantity = finding.quantity == null ? '' : ` = ${finding.quantity} ${finding.unit}`;
  const located = finding.geometry?.bbox ? ' [bbox]' : finding.geometry?.point ? ' [point]' : '';
  console.log(`  p${finding.page_number ?? '-'} [${finding.finding_type}] ${finding.label.slice(0, 58)}${quantity}${located}`);
  if (finding.source_excerpt) console.log(`      "${finding.source_excerpt.slice(0, 100)}"`);
}
console.log(`limitations (${reading.summary.limitations.length}):`);
for (const note of reading.summary.limitations) console.log(`  - ${note.slice(0, 200)}`);

if (outPath) {
  writeFileSync(outPath, JSON.stringify({ model, pageCount, reading }, null, 2));
  console.log(`\nwrote ${outPath}`);
}
