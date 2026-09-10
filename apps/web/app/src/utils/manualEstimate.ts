import type { EstimateItem, Project, QuantityItem } from "../types/index.ts";

const money = (value: number) => Number(value.toFixed(2));

export function validateEstimateInput(name: string, quantity: number, costs: number[] = []): string {
  if (!name.trim()) return "Item description is required.";
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > Number.MAX_SAFE_INTEGER) return "Enter a valid quantity greater than zero.";
  if (costs.some((cost) => !Number.isFinite(cost) || cost < 0)
    || !Number.isSafeInteger(Math.round(costs.reduce((total, cost) => total + cost, 0) * 100))) {
    return "Costs must be valid amounts of zero or more, within the supported currency range.";
  }
  return "";
}

export function createUnpricedEstimateItem(quantity: QuantityItem): EstimateItem {
  return {
    id: `est-${crypto.randomUUID()}`,
    quantityId: quantity.id,
    name: quantity.name,
    quantity: quantity.quantity,
    unit: quantity.unit,
    materialCost: 0,
    laborCost: 0,
    equipmentCost: 0,
    directCost: 0,
  };
}

/** Preserve the entered unit cost when a takeoff changes. A different unit needs new pricing. */
function syncEstimateQuantity(item: EstimateItem, quantity: QuantityItem): EstimateItem {
  const changed = item.quantity !== quantity.quantity || item.unit !== quantity.unit;
  const factor = !changed ? 1 : item.unit === quantity.unit && item.quantity > 0
    ? quantity.quantity / item.quantity
    : 0;
  const materialCost = money(item.materialCost * factor);
  const laborCost = money(item.laborCost * factor);
  const equipmentCost = money(item.equipmentCost * factor);
  const error = validateEstimateInput(quantity.name, quantity.quantity, [materialCost, laborCost, equipmentCost]);
  if (error) throw new Error(error);
  return {
    ...item,
    name: quantity.name,
    quantity: quantity.quantity,
    unit: quantity.unit,
    materialCost,
    laborCost,
    equipmentCost,
    directCost: money(materialCost + laborCost + equipmentCost),
  };
}

export function updateTakeoffQuantity(
  project: Project,
  id: string,
  patch: Pick<QuantityItem, "name" | "quantity" | "unit">,
): Project {
  const existing = project.quantities.find((item) => item.id === id);
  if (!existing) return project;
  const error = validateEstimateInput(patch.name, patch.quantity);
  if (error) throw new Error(error);
  const quantity = { ...existing, name: patch.name.trim(), quantity: patch.quantity, unit: patch.unit };
  return {
    ...project,
    quantities: project.quantities.map((item) => item.id === id ? quantity : item),
    estimateItems: project.estimateItems.map((item) => item.quantityId === id
      ? syncEstimateQuantity(item, quantity)
      : item),
  };
}

/** Estimate inputs are explicitly totals. Preserve those totals and sync linked takeoff metadata. */
export function editEstimateLine(
  project: Project,
  id: string,
  patch: Pick<EstimateItem, "name" | "csiCode" | "quantity" | "unit" | "materialCost" | "laborCost" | "equipmentCost">,
): Project {
  const existing = project.estimateItems.find((item) => item.id === id);
  if (!existing) return project;
  const error = validateEstimateInput(patch.name, patch.quantity, [patch.materialCost, patch.laborCost, patch.equipmentCost]);
  if (error) throw new Error(error);
  const updated = existing.quantityId ? updateTakeoffQuantity(project, existing.quantityId, patch) : project;
  const materialCost = money(patch.materialCost);
  const laborCost = money(patch.laborCost);
  const equipmentCost = money(patch.equipmentCost);
  return {
    ...updated,
    estimateItems: updated.estimateItems.map((item) => item.id === id ? {
      ...existing,
      name: patch.name.trim(),
      ...(patch.csiCode !== undefined ? { csiCode: patch.csiCode } : {}),
      quantity: patch.quantity,
      unit: patch.unit,
      materialCost, laborCost, equipmentCost,
      directCost: money(materialCost + laborCost + equipmentCost),
      pricingStatus: materialCost + laborCost + equipmentCost > 0 ? 'configured' : 'missing_price',
      pricingSource: 'Estimator entered costs',
    } : item),
  };
}
