import { validatePhotoSelection } from './photoReview.ts';

export const ESTIMATE_SERVICES = [
  { id: 'tile', label: 'Tile', trade: 'Finishes' },
  { id: 'flooring', label: 'Flooring', trade: 'Finishes' },
  { id: 'painting', label: 'Painting', trade: 'Finishes' },
  { id: 'drywall', label: 'Drywall', trade: 'Drywall' },
  { id: 'framing', label: 'Framing', trade: 'Framing' },
  { id: 'concrete', label: 'Concrete', trade: 'Concrete' },
  { id: 'electrical', label: 'Electrical', trade: 'Electrical' },
  { id: 'plumbing', label: 'Plumbing', trade: 'Plumbing' },
  { id: 'hvac', label: 'HVAC', trade: 'HVAC' },
] as const;
export const ESTIMATE_FILE_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp';

export function estimateServiceScope(ids: readonly string[]) {
  const services = ESTIMATE_SERVICES.filter(service => ids.includes(service.id));
  if (!services.length || ids.some(id => !ESTIMATE_SERVICES.some(service => service.id === id))) {
    throw new Error('Choose at least one supported service.');
  }
  return { trades: [...new Set(services.map(service => service.trade))], scope: services.map(service => service.label).join(', ') };
}

/** Validate the entire selection before any upload or project mutation. */
export function splitEstimateFiles(files: readonly File[]) {
  if (!files.length) throw new Error('Add photos, PDF plans, or both.');
  const plans: File[] = [], photos: File[] = [];
  const types: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  for (const file of files) {
    const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
    const type = types[extension];
    if (!type || (file.type && file.type !== type)) throw new Error(`${file.name}: use PDF, JPEG, PNG or WebP. Export HEIC photos as JPEG first.`);
    if (!Number.isSafeInteger(file.size) || file.size < 1) throw new Error(`${file.name}: the file is empty or invalid.`);
    const normalized = file.type ? file : new File([file], file.name, { type, lastModified: file.lastModified });
    if (type === 'application/pdf') {
      if (file.size > 50 * 1024 * 1024) throw new Error(`${file.name}: PDFs must be no larger than 50 MB.`);
      plans.push(normalized);
    } else photos.push(normalized);
  }
  if (plans.length > 20) throw new Error('Select no more than 20 PDF plans at a time.');
  if (photos.length) { const error = validatePhotoSelection(photos); if (error) throw new Error(error); }
  return { plans, photos };
}
