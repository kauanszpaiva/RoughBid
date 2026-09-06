import type { Project } from '../types/index.ts';

export function projectReadiness(project: Project) {
  const currentPlan = project.revisions.find(revision => revision.isCurrent) ?? project.revisions.at(-1);
  const hasPlan = Boolean(currentPlan?.remoteFileId);
  const hasQuantities = project.quantities.length > 0 && project.quantities.every(item => Number.isFinite(item.quantity) && item.quantity > 0 && item.name.trim());
  const hasEstimate = project.estimateItems.length > 0 && project.estimateItems.every(item => {
    const costs = [item.materialCost, item.laborCost, item.equipmentCost];
    const total = costs.reduce((sum, cost) => sum + cost, 0);
    return item.name.trim() && Number.isFinite(item.quantity) && item.quantity > 0 && costs.every(cost => Number.isFinite(cost) && cost >= 0) && total > 0 && Number.isFinite(item.directCost) && Math.abs(total - item.directCost) < 0.02;
  });
  const hasSettings = [project.overheadPercentage, project.markupPercentage].every(value => Number.isFinite(value) && value >= 0 && value <= 1000);
  const issues = [!hasPlan && 'upload a saved PDF', !hasQuantities && 'add valid takeoff quantities', !hasEstimate && 'price every estimate line', !hasSettings && 'check overhead and markup'].filter(Boolean) as string[];
  return { hasPlan, hasQuantities, hasEstimate, hasSettings, canExport: issues.length === 0, issues };
}
