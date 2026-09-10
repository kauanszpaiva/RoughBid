import { parseSupplierPriceCsv, SUPPLIER_CSV_MAX_BYTES } from '../../../../packages/domain/src/supplier-price-import.ts';
import type { SupabaseLike } from '../projects/service.ts';
import { getMarketplaceAccess } from './catalog.ts';

const json = (body: unknown, status = 200) => Response.json(body, {status, headers: {'cache-control': 'private, no-store'}});

/** Validates each import against current access; never stores or logs supplier CSVs. */
export async function handleSupplierPriceImport(request: Request, db: SupabaseLike, env: Record<string, string | undefined>): Promise<Response> {
  if (request.method !== 'POST') return json({error: 'Method not allowed'}, 405);
  const access = await getMarketplaceAccess(request, db, env);
  if (access instanceof Response) return access;
  if (!['admin', 'estimator'].includes(access.role)) return json({error: 'This workspace is read-only for your account.'}, 403);
  if (!access.entitled) return json({error: 'An active Supplier Price Import subscription is required. Refresh Marketplace access or contact your workspace administrator.'}, 403);
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/csv') return json({error: 'Upload a supplier CSV file.'}, 415);
  const tooLarge = () => json({error: 'Supplier CSV is limited to 2 MB.'}, 413);
  if (Number(request.headers.get('content-length')) > SUPPLIER_CSV_MAX_BYTES) return tooLarge();
  const reader = request.body?.getReader();
  if (!reader) return json({error: 'Choose a non-empty CSV file.'}, 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SUPPLIER_CSV_MAX_BYTES) { await reader.cancel(); return tooLarge(); }
      chunks.push(value);
    }
  } catch {
    return json({error: 'Unable to read the supplier CSV. Try uploading the file again.'}, 400);
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let csv: string;
  try { csv = new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
  catch { return json({error: 'Save the CSV using UTF-8 encoding and try again.'}, 400); }
  try { return json({materials: parseSupplierPriceCsv(csv)}); }
  catch (error) { return json({error: error instanceof Error ? error.message : 'Supplier CSV could not be imported.'}, 400); }
}
