/**
 * Live probe: runs the real OpenAI plan-reading path against a real PDF.
 *
 * It uses the production reader, the production prompts and the production
 * local extractors (vector linework + printed-text transcript); the only thing
 * faked is the database writer, so the company spend breaker and the token
 * telemetry are observed instead of persisted. The API key is read from the
 * environment and is never printed.
 *
 *   OPENAI_API_KEY=... OPENAI_MODEL=gpt-4o-mini \
 *   node --experimental-strip-types scripts/live-plan-reading-probe.ts <plan.pdf> [--batch N]
 *
 * Add --local-only to inspect a set and see how many provider requests a live
 * reading would take without spending anything or sending the file anywhere.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { OpenAiCompatibleVisionPlanReader, requireOpenAiVisionConfig } from '../apps/api/src/ai-plan/openai-vision.ts';
import { extractDrawingLinework, lineworkOptionsFromEnv, vectorLineworkEnabled } from '../apps/api/src/ai-plan/drawing-linework.ts';
import { extractSheetText, sheetTextOptionsFromEnv, sheetTextEnabled, verifyFindingPages } from '../apps/api/src/ai-plan/sheet-text.ts';
import { countPdfPages, planPageWindows } from '../apps/api/src/ai-plan/plan-batches.ts';
import { withUsageMeter } from '../apps/api/src/owner-usage/meter.ts';

const [planPath, ...rest] = process.argv.slice(2);
if (!planPath) throw new Error('Usage: live-plan-reading-probe.ts <plan.pdf> [--batch N] [--out file.json] [--local-only]');
const batchFlag = rest.indexOf('--batch');
const outFlag = rest.indexOf('--out');
const tradesFlag = rest.indexOf('--trades');
const scopeFlag = rest.indexOf('--scope');
const outPath = outFlag >= 0 ? rest[outFlag + 1] : null;
const localOnly = rest.includes('--local-only');
// The service always sends a validated, non-empty trade list; an empty one is
// not a realistic reading and the model correctly reports almost nothing for it.
const trades = tradesFlag >= 0
  ? rest[tradesFlag + 1]!.split(',').map(value => value.trim()).filter(Boolean)
  : ['Framing', 'Concrete', 'Drywall', 'Electrical', 'Plumbing', 'HVAC', 'Finishes'];
const scope = scopeFlag >= 0 ? rest[scopeFlag + 1]! : 'Full takeoff of the supplied set.';

if (!localOnly && !process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required in the environment (or pass --local-only).');

const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const batchPages = batchFlag >= 0 ? Number(rest[batchFlag + 1]) : 8;
const env: Record<string, string | undefined> = {
  ...process.env,
  OPENAI_PLAN_READING_ENABLED: 'true',
  OPENAI_MODEL: model,
  ...(batchFlag >= 0 ? { AI_PLAN_OPENAI_BATCH_PAGES: rest[batchFlag + 1] } : {}),
};

const bytes = new Uint8Array(readFileSync(planPath));
const pageCount = await countPdfPages(bytes);

console.log(`plan: ${planPath} (${bytes.byteLength} bytes, ${pageCount} pages)`);
console.log(localOnly
  ? 'mode: local only (nothing is sent anywhere)'
  : `model: ${model} | api key: ${process.env.OPENAI_API_KEY!.length} chars (not printed)`);
if (!localOnly) console.log(`trades: ${trades.join(', ')} | scope: ${scope}`);

// ---- local, zero-cost evidence, exactly as the service builds it ----
const started = Date.now();
const linework = vectorLineworkEnabled(env) ? await extractDrawingLinework(bytes, lineworkOptionsFromEnv(env)) : undefined;
const sheetText = sheetTextEnabled(env) ? await extractSheetText(bytes, sheetTextOptionsFromEnv(env)) : undefined;
console.log(`local evidence: ${Date.now() - started} ms | linework pages ${linework?.pages.length ?? 0} | text pages ${sheetText?.pages.length ?? 0} | transcript ${sheetText?.characters ?? 0} chars`);

const scanned: number[] = [];
for (const page of sheetText?.pages ?? []) {
  if (page.likelyScanned) scanned.push(page.pageNumber);
  console.log(`  page ${page.pageNumber}: sheet ${page.sheetNumber ?? '-'} | scale ${page.scale ?? '-'} | ${page.characters} chars | headings: ${page.headings.slice(0, 2).join('; ') || '-'}`);
}
if (scanned.length) console.log(`  pages with little or no text layer (drawn or scanned): ${scanned.join(', ')}`);
if (linework) {
  const strokes = linework.pages.reduce((sum, page) => sum + page.vertical.count + page.horizontal.count, 0);
  const regions = linework.pages.reduce((sum, page) => sum + page.regions.length, 0);
  console.log(`  measured drawing: ${strokes} wall-like strokes, ${regions} closed region(s)`);
}

if (localOnly) {
  const windows = planPageWindows(pageCount, batchPages, 60);
  console.log(`\na live reading of this set would take ${windows.length} provider request(s) of up to ${batchPages} page(s):`);
  for (const window of windows) console.log(`  pages ${window.from}-${window.to}`);
  console.log(`each request reserves one call against provider_spend_policy (default 25.00 cap, 2.50 per call).`);
} else {

// ---- the provider call itself, with metering observed ----
const reservations: Array<Record<string, unknown>> = [];
const settlements: Array<Record<string, unknown>> = [];
let httpCalls = 0;
const fetcher = (async (url: string, init?: any) => {
  httpCalls += 1;
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const filePart = body?.messages?.[1]?.content?.find((part: any) => part?.type === 'file');
  const textParts = body?.messages?.[1]?.content?.filter((part: any) => part?.type === 'text') ?? [];
  console.log(`  -> request ${httpCalls} to ${String(url).replace(/[?].*$/, '')} model=${body?.model} file=${filePart?.file?.filename ?? 'none'} promptParts=${textParts.length}`);
  if (httpCalls === 1 && textParts[0]?.text) console.log(`     prompt: ${String(textParts[0].text).split('\n')[0].slice(0, 110)}`);
  return fetch(url, init as any);
}) as unknown as typeof fetch;

const writer = {
  from: () => ({
    insert: async (row: Record<string, unknown>) => { settlements.push({ op: 'insert', ...row }); return { error: null }; },
    update: (patch: Record<string, unknown>) => ({ eq: async () => { settlements.push({ op: 'update', ...patch }); return { error: null }; } }),
  }),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'reserve_provider_spend') { reservations.push(args); return { data: {}, error: null }; }
    return { data: {}, error: null };
  },
};

const reader = new OpenAiCompatibleVisionPlanReader(requireOpenAiVisionConfig(env), fetcher);
const providerStarted = Date.now();
const result = await withUsageMeter(
  { writer, userId: 'probe-user', workspaceId: 'probe-workspace', projectId: 'probe-project', jobId: 'probe-job', billing: 'paid' },
  () => reader.read({
    fileBytes: bytes,
    mimeType: 'application/pdf',
    sheetName: planPath.split(/[\\/]/).pop()!,
    requestedTrades: trades,
    scope,
    ...(linework ? { linework } : {}),
    ...(sheetText ? { sheetText } : {}),
    pageCount,
  }),
);
const providerMs = Date.now() - providerStarted;

// ---- report ----
console.log(`\nprovider requests: ${httpCalls} | reservations: ${reservations.length} | ${(providerMs / 1000).toFixed(1)} s`);
const tokenRows = settlements.filter(row => typeof row.input_tokens === 'number');
const inputTokens = tokenRows.reduce((sum, row) => sum + Number(row.input_tokens ?? 0), 0);
const outputTokens = tokenRows.reduce((sum, row) => sum + Number(row.output_tokens ?? 0), 0);
console.log(`tokens reported by the provider: input ${inputTokens}, output ${outputTokens}`);

// Same post-processing the service performs on every reading.
const citation = verifyFindingPages(result.findings, sheetText);
result.findings = citation.findings;
console.log(`\ncitation check: ${citation.checked} checked | ${citation.corrected} page(s) corrected from the local transcript | ${citation.unlocated} unlocated`);

console.log(`\nsheet_count: ${result.summary.sheet_count} | trades: ${result.summary.detected_trade_scope.join(', ') || '-'} | scale: ${result.summary.scale_status}`);
console.log(`findings: ${result.findings.length}`);
// The owner's question is specifically "does it see the drawn spaces and doors,
// or only the printed text?", so the tally is by type and by located-ness.
const byType = new Map<string, number>();
let located = 0;
for (const finding of result.findings) {
  byType.set(finding.finding_type, (byType.get(finding.finding_type) ?? 0) + 1);
  const bbox = (finding.geometry as { bbox?: unknown } | undefined)?.bbox;
  if (Array.isArray(bbox) && bbox.length === 4) located += 1;
}
console.log(`by type: ${[...byType.entries()].map(([type, count]) => `${type} ${count}`).join(' | ') || '-'}`);
console.log(`findings carrying a bbox (a drawn location): ${located} of ${result.findings.length}`);
for (const finding of result.findings) {
  const quantity = finding.quantity == null ? '' : ` = ${finding.quantity} ${finding.unit}`;
  console.log(`  p${finding.page_number ?? '-'} [${finding.finding_type}] ${finding.label.slice(0, 62)}${quantity}`);
  if (finding.source_excerpt) console.log(`      "${finding.source_excerpt.slice(0, 100)}"`);
}
console.log(`limitations (${result.summary.limitations.length}):`);
for (const note of result.summary.limitations) console.log(`  - ${note.slice(0, 200)}`);

if (outPath) {
  writeFileSync(outPath, JSON.stringify({ model, pageCount, httpCalls, reservations: reservations.length, inputTokens, outputTokens, result }, null, 2));
  console.log(`\nwrote ${outPath}`);
}
}