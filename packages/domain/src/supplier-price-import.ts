export const SUPPLIER_CSV_MAX_BYTES = 2 * 1024 * 1024;
export type SupplierPriceUnit = 'SF' | 'LF' | 'EA' | 'CY' | 'SY' | 'HR' | 'LS';
export type SupplierPriceItem = {
  id: string; name: string; category: string; unit: SupplierPriceUnit;
  unitCost: number; unitPrice: number; supplier: string; lastUpdated: string;
};

const units = new Set<SupplierPriceUnit>(['SF', 'LF', 'EA', 'CY', 'SY', 'HR', 'LS']);
const key = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

function rows(csv: string): string[][] {
  const output: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closedQuote = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i]!;
    if (quoted) {
      if (char === '"' && csv[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else field += char;
      continue;
    }
    if (closedQuote && ![',', '\n', '\r'].includes(char)) throw new Error('CSV contains an invalid quote.');
    if (char === '"') {
      if (field) throw new Error('CSV contains an invalid quote.');
      quoted = true;
    } else if (char === ',') {
      row.push(field); field = ''; closedQuote = false;
    } else if (char === '\n') {
      row.push(field); output.push(row); row = []; field = ''; closedQuote = false;
      if (output.length > 2001) throw new Error('Supplier CSV is limited to 2,000 rows.');
    } else if (char !== '\r') field += char;
  }
  if (quoted) throw new Error('CSV contains an unclosed quote.');
  if (field || row.length || closedQuote) { row.push(field); output.push(row); }
  if (output.length > 2001) throw new Error('Supplier CSV is limited to 2,000 rows.');
  return output.filter(values => values.some(value => value.trim()));
}

export function parseSupplierPriceCsv(csv: string, idFactory: () => string = () => crypto.randomUUID()): SupplierPriceItem[] {
  if (new TextEncoder().encode(csv).byteLength > SUPPLIER_CSV_MAX_BYTES) throw new Error('Supplier CSV is limited to 2 MB.');
  if (!csv.trim()) throw new Error('Choose a non-empty CSV file.');
  const parsed = rows(csv.replace(/^\uFEFF/, ''));
  const headers = (parsed.shift() ?? []).map(key);
  const position = (...names: string[]) => {
    const matches = headers.map((header, index) => names.includes(header) ? index : -1).filter(index => index >= 0);
    if (matches.length > 1) throw new Error('CSV contains duplicate or ambiguous headers.');
    return matches[0] ?? -1;
  };
  const nameIndex = position('name', 'material', 'item');
  const categoryIndex = position('category');
  const unitIndex = position('unit', 'uom');
  const costIndex = position('unitcost', 'cost', 'unitprice', 'price');
  const supplierIndex = position('supplier', 'vendor');
  if (nameIndex < 0 || unitIndex < 0 || costIndex < 0) throw new Error('CSV headers must include Name, Unit, and Unit cost.');
  const imported: SupplierPriceItem[] = [], seen = new Set<string>();
  parsed.forEach((values, index) => {
    const line = index + 2;
    if (values.length > headers.length) throw new Error(`Row ${line} has extra columns. Quote values that contain commas.`);
    const name = (values[nameIndex] ?? '').trim();
    const unit = (values[unitIndex] ?? '').trim().toUpperCase() as SupplierPriceUnit;
    const rawCost = (values[costIndex] ?? '').trim();
    // Missing prices must never silently become zero; accept explicit decimal USD only.
    if (!/^\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(rawCost)) throw new Error(`Row ${line} has an invalid unit cost.`);
    const cost = Number(rawCost.replace(/^\$/, '').replaceAll(',', ''));
    const category = categoryIndex >= 0 ? (values[categoryIndex] ?? '').trim() : '';
    const supplier = supplierIndex >= 0 ? (values[supplierIndex] ?? '').trim() : '';
    if (!name || name.length > 200) throw new Error(`Row ${line} has an invalid material name.`);
    if (!units.has(unit)) throw new Error(`Row ${line} has an unsupported unit. Use SF, LF, EA, CY, SY, HR, or LS.`);
    if (!Number.isFinite(cost) || cost < 0 || cost > 1_000_000) throw new Error(`Row ${line} has an invalid unit cost.`);
    if (category.length > 100 || supplier.length > 200) throw new Error(`Row ${line} has an overlong category or supplier.`);
    const identity = `${name.toLowerCase()}\n${supplier.toLowerCase()}\n${unit}`;
    if (seen.has(identity)) throw new Error(`Row ${line} duplicates another material in this file.`);
    seen.add(identity);
    imported.push({id: `mat-${idFactory()}`, name, category, unit, unitCost: Number(cost.toFixed(2)), unitPrice: Number(cost.toFixed(2)), supplier, lastUpdated: new Date().toISOString()});
  });
  if (!imported.length) throw new Error('The CSV contains no material rows.');
  return imported;
}

export const SUPPLIER_CSV_TEMPLATE = 'Name,Category,Unit,Unit cost,Supplier\n5/8 inch drywall board,Drywall,EA,14.25,Example Supplier\n';
