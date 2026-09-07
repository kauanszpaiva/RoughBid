import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { ProjectApiError } from '../projects/service.ts';
import { projectChargeCents, type ProjectMembership } from '../../../../packages/domain/src/project-charge.ts';
import { isConfiguredValue } from '../ai-plan/readiness.ts';

export const MAX_AI_PDF_BYTES = 50 * 1024 * 1024;
export const MAX_AI_PAGES = 100;
export const PROJECT_TRADES = ['Framing', 'Concrete', 'Drywall', 'Electrical', 'Plumbing', 'HVAC', 'Finishes'] as const;
export const PDF_DIGEST = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function downloadPlan(url: string, fetcher: typeof fetch = fetch): Promise<Uint8Array> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new ProjectApiError(502, 'Could not download the uploaded plan.');
  if (Number(response.headers.get('content-length')) > MAX_AI_PDF_BYTES) {
    await response.body.cancel();
    throw new ProjectApiError(413, 'Split the PDF into files no larger than 50 MB.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AI_PDF_BYTES) throw new ProjectApiError(413, 'Split the PDF into files no larger than 50 MB.');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function inspectPdf(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > MAX_AI_PDF_BYTES) throw new ProjectApiError(413, 'PDF must be between 1 byte and 50 MB.');
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new ProjectApiError(415, 'Upload a valid PDF.');
  let pdf: PDFDocument;
  try { pdf = await PDFDocument.load(bytes, { updateMetadata: false }); }
  catch { throw new ProjectApiError(415, 'This PDF is damaged or password protected. Upload an unlocked PDF.'); }
  const pages = pdf.getPageCount();
  if (!pages || pages > MAX_AI_PAGES) throw new ProjectApiError(413, 'Use a PDF with 1 to 100 pages. Split larger plan sets.');
  return { pages, byteSize: bytes.length, sha256: PDF_DIGEST(bytes) };
}

export function normalizeScope(input: Record<string, unknown>) {
  const trades = input.trades === undefined ? [...PROJECT_TRADES] : input.trades;
  if (!Array.isArray(trades) || !trades.length || trades.length > PROJECT_TRADES.length || trades.some(t => !PROJECT_TRADES.includes(t))) throw new ProjectApiError(400, 'Select valid trades for this project.');
  const scope = input.scope ?? '';
  if (typeof scope !== 'string' || scope.length > 500) throw new ProjectApiError(400, 'Scope must be at most 500 characters.');
  return { trades: [...new Set(trades)].sort() as string[], scope: scope.trim() };
}

/** No speculative production defaults. Operations must configure a measured cost policy. */
export function quoteProject(pages: number, trades: number, membership: ProjectMembership, env: Record<string, string | undefined>) {
  const read = (name: string, min: number) => {
    const raw = env[name];
    const value = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || value < min) throw new ProjectApiError(503, 'Project pricing is not configured. Please contact support.');
    return value;
  };
  const base = read('PROJECT_COST_BASE_CENTS', 1);
  const perPage = read('PROJECT_COST_PAGE_CENTS', 1);
  const perTrade = read('PROJECT_COST_TRADE_CENTS', 0);
  const fixed = read('PROJECT_PAYMENT_FIXED_CENTS', 0);
  const feeBps = read('PROJECT_PAYMENT_FEE_BPS', 0);
  const version = env.PROJECT_PRICING_VERSION?.trim();
  if (!isConfiguredValue(version) || version.length > 80) throw new ProjectApiError(503, 'Project pricing is not configured. Please contact support.');
  // Cost policy must cover both bounded attempts, output limits, storage and support.
  const cost = base + pages * perPage + trades * perTrade;
  return { amountCents: projectChargeCents(cost, fixed, feeBps, membership), costCents: cost, version };
}
