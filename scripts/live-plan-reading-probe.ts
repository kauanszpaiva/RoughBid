/**
 * Live probe: runs the real OpenAI plan-reading path against a real PDF.
 *
 * It uses the production reader, the production prompts and the production
 * local extractors (vector linework + printed-text transcript); the only thing
 * faked is the database writer, so the company spend breaker and the token
 * telemetry are observed instead of persisted. The API key is read from the
 * environment and is never printed.
 *
 *   OPENAI_API_KEY=... OPENAI_MODEL=gpt-4.1-nano \
 *   node --experimental-strip-types scripts/live-plan-reading-probe.ts <plan.pdf> [--batch N]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { OpenAiCompatibleVisionPlanReader, requireOpenAiVisionConfig } from '../apps/api/src/ai-plan/openai-vision.ts';
import { extractDrawingLinework, vectorLineworkEnabled } from '../apps/api/src/ai-plan/drawing-linework.ts';
import { extractSheetText, sheetTextOptionsFromEnv, sheetTextEnabled, verifyFindingPages } from '../apps/api/src/ai-plan/sheet-text.ts';
import { countPdfPages } from '../apps/api/src/ai-plan/plan-batches.ts';
import { withUsageMeter } from '../apps/api/src/owner-usage/meter.ts';

const [planPath, ...rest] = process.argv.slice(2);
if (!planPath) throw new Error('Usage: live-plan-reading-probe.ts <plan.pdf> [--batch N] [--out file.json]');
const batchFlag = rest.indexOf('--batch');
const outFlag = rest.indexOf('--out');
const outPath = outFlag >= 0 ? rest[outFlag + 1] : null;

if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required in the environment.');

const model = process.env.OPENAI_MODEL || 'gpt-4.1-nano';
const env: Record<string, string | undefined> = {
  ...process.env,
  OPENAI_PLAN_READING_ENABLED: 'true',
  OPENAI_MODEL: model,
  ...(batchFlag >= 0 ? { AI_PLAN_OPENAI_BATCH_PAGES: rest[batchFlag + 1] } : {}),
};

const bytes = new Uint8Array(readFileSync(planPath));
const pageCount = await countPdfPages(bytes);

console.log(`plan: ${planPath} (${bytes.byteLength} bytes, ${pageCount} pages)`);
console.log(`model: ${model} | api key: ${process.env.OPENAI_API_KEY.length} chars (not printed)`);

// ---- local, zero-cost evidence, exactly as the service builds it ----
const started = Date.now();
const linework = vectorLineworkEnabled(env) ? await extractDrawingLinework(bytes) : undefined;
const sheetText = sheetTextEnabled(env) ? await extractSheetText(bytes, sheetTextOptionsFromEnv(env)) : undefined;
console.log(`local evidence: ${Date.now() - started} ms | linework pages ${linework?.pages.length ?? 0} | text pages ${sheetText?.pages.length ?? 0} | transcript ${sheetText?.characters ?? 0} chars`);
for (const page of sheetText?.pages ?? []) {
  console.log(`  page ${page.pageNumber}: sheet ${page.sheetNumber ?? '-'} | scale ${page.scale ?? '-'} | ${page.characters} chars | headings: ${page.headings.slice(0, 2).join('; ') || '-'}`);
}

// ---- the provider call itself, with metering observed ----
const reservations: Array<Record<string, unknown>> = [];
const settlements: Array<Record<string, unknown>> = [];
let httpCalls = 0;
const fetcher = (async (url: string, init?: any) => {
  httpCalls += 1;
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const filePart = body?.messages?.[1]?.content?.find((part: any) => part?.type === 'file');
  const promptPart = body?.messages?.[1]?.content?.find((part: any) => part?.type === 'text');
  const textParts = body?.messages?.[1]?.content?.filter((part: any) => part?.type === 'text') ?? [];
  console.log(`  -> request ${httpCalls} to ${String(url).replace(/[?].*$/, '')} model=${body?.model} file=${filePart?.file?.filename ?? 'none'} promptParts=${textParts.length}`);
  if (httpCalls === 1 && promptPart?.text) console.log(`     prompt: ${String(promptPart.text).split('\n')[0].slice(0, 110)}`);
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
    requestedTrades: [],
    scope: null,
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