import type { PlanReadingFinding } from '../services/api.ts';
import type { EstimateItem, Project, QuantityItem } from '../types/index.ts';

export const hasUnverifiedAiPrice = (item: EstimateItem) => item.pricingSource === 'AI Finding Geometry Pricing';

export function flagUnverifiedAiPrice(item: EstimateItem): EstimateItem {
  // Keep historical amounts and their origin available for human review.
  return hasUnverifiedAiPrice(item) ? { ...item, pricingStatus: 'missing_price' } : item;
}

export function findingAreaName(finding: PlanReadingFinding): string {
  if (typeof finding.geometry?.area === 'string' && finding.geometry.area.trim()) return finding.geometry.area.trim();
  if (typeof finding.geometry?.room === 'string' && finding.geometry.room.trim()) return finding.geometry.room.trim();
  if (finding.finding_type === 'room' && finding.label.trim()) return finding.label.trim();
  return 'Unknown Area';
}

export type PlanReadingMode = 'visual_pdf' | 'visual_page_images' | 'text_only' | 'unknown';

/**
 * What the API actually inspected. A job that never records the mode is not
 * evidence that the drawing was read, so it is reported as unrecorded.
 */
export function readingModeStatus(mode: unknown): { mode: PlanReadingMode; label: string; detail: string; visual: boolean } {
  if (mode === 'visual_pdf') {
    return {
      mode, visual: true, label: 'Drawing inspected',
      detail: 'The AI read the plan itself — line work, walls, openings, symbols, icons, hatches and graphic scale — not only the printed text.',
    };
  }
  if (mode === 'visual_page_images') {
    return {
      mode, visual: true, label: 'Rendered drawing pages inspected',
      detail: 'The AI read server-rendered page images of the drawing, including symbols, icons, hatch patterns and graphic scale.',
    };
  }
  if (mode === 'text_only') {
    return {
      mode, visual: false, label: 'Text only — drawings NOT inspected',
      detail: 'This reading used extracted PDF text only. Line work, symbols, icons and graphic scale were not reviewed.',
    };
  }
  return {
    mode: 'unknown', visual: false, label: 'Reading mode not recorded',
    detail: 'This older reading does not record whether the drawing itself was inspected. Verify the plan manually.',
  };
}

/** Graphic evidence attached to a finding: an icon, symbol, hatch, line type or graphic scale. */
export function findingGraphicEvidence(finding: PlanReadingFinding): { kind: string; description: string } | null {
  const visual = finding.geometry?.visual;
  if (!visual || typeof visual !== 'object' || Array.isArray(visual)) return null;
  const kind = (visual as { kind?: unknown }).kind;
  const description = (visual as { description?: unknown }).description;
  if (typeof kind !== 'string' || !kind.trim() || typeof description !== 'string' || !description.trim()) return null;
  return { kind: kind.trim(), description: description.trim() };
}

// Findings contain source evidence, never verified construction prices.
export function groupAiFindingsByArea(findings: PlanReadingFinding[]) {
  const groups = new Map<string, { areaName: string; findings: PlanReadingFinding[]; pages: Set<number>; unpricedCount: number }>();
  for (const finding of findings) {
    if (finding.status === 'rejected') continue;
    const areaName = findingAreaName(finding);
    let group = groups.get(areaName);
    if (!group) {
      group = { areaName, findings: [], pages: new Set(), unpricedCount: 0 };
      groups.set(areaName, group);
    }
    group.findings.push(finding);
    if (finding.page_number) group.pages.add(finding.page_number);
    if (finding.quantity !== null && finding.quantity > 0) group.unpricedCount += 1;
  }
  return [...groups.values()].sort((a, b) => a.areaName.localeCompare(b.areaName));
}

export function appendAcceptedAiQuantity(
  project: Project,
  item: Omit<QuantityItem, 'id' | 'itemNumber'>,
  newId: () => string = () => crypto.randomUUID(),
): Project {
  if (item.findingId && project.quantities.some(quantity => quantity.findingId === item.findingId)) return project;
  const quantityId = `qty-${newId()}`;
  const quantity = { ...item, id: quantityId, itemNumber: project.quantities.length + 1 };
  return {
    ...project,
    quantities: [...project.quantities, quantity],
    estimateItems: [...project.estimateItems, {
      id: `est-${newId()}`, quantityId, name: item.name, quantity: item.quantity, unit: item.unit,
      materialCost: 0, laborCost: 0, equipmentCost: 0, directCost: 0,
      pricingStatus: 'missing_price',
      ...(item.findingId === undefined ? {} : { findingId: item.findingId }),
      ...(item.pageNumber === undefined ? {} : { pageNumber: item.pageNumber }),
      ...(item.area === undefined ? {} : { area: item.area }),
      ...(item.sourceExcerpt === undefined ? {} : { sourceExcerpt: item.sourceExcerpt }),
    }],
  };
}
