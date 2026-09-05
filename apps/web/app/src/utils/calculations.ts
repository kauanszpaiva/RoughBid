import type { EstimateItem, FinancialCalculation } from "../types";
// Same fixed-point engine the real backend exposes at POST /api/estimates/recalculate
// (apps/api/src/estimates/routes.ts). Importing it directly here means this app's
// totals already match the backend bit-for-bit, ahead of the network call being wired
// up — see calculateProjectFinancials below and services/api.ts's recalculateEstimate.
import { calculateProject } from "../../../../../packages/domain/src/calculation.ts";

/**
 * Calculates Direct Cost for a single line item:
 * Direct Cost = Material Cost + Labor Cost + Equipment / Other Cost
 */
export function calculateLineDirectCost(
  materialCost: number,
  laborCost: number,
  equipmentCost: number
): number {
  const m = Math.max(0, Number(materialCost) || 0);
  const l = Math.max(0, Number(laborCost) || 0);
  const e = Math.max(0, Number(equipmentCost) || 0);
  return Number((m + l + e).toFixed(2));
}

/**
 * Deterministic Financial Engine
 * Calculates Direct Cost, Overhead, Markup, Final Price, and Margin.
 *
 * Delegates to packages/domain's calculateProject — the exact fixed-point (no
 * float drift) calculation the backend uses — instead of re-implementing the
 * math here. Each line item's material/labor/equipment costs become three
 * `unitRate` line items (quantity 1) so the shared engine can total them by
 * category. TODO(joshua-backend): once this app has a real session, prefer
 * POST /api/estimates/recalculate (services/api.ts#recalculateEstimate) for a
 * server-verified total and keep this local call as the offline/mock fallback.
 */
export function calculateProjectFinancials(
  items: EstimateItem[],
  overheadPercentage: number = 12,
  markupPercentage: number = 20
): FinancialCalculation {
  const overheadPct = Math.max(0, Number(overheadPercentage) || 0);
  const markupPct = Math.max(0, Number(markupPercentage) || 0);
  const rate = (value: number) => Math.max(0, Number(value) || 0).toFixed(2);

  const lineItems = items.flatMap((item) => [
    { id: `${item.id}-material`, category: "material" as const, quantity: 1, unitRate: rate(item.materialCost) },
    { id: `${item.id}-labor`, category: "labor" as const, quantity: 1, unitRate: rate(item.laborCost) },
    { id: `${item.id}-equipment`, category: "equipment" as const, quantity: 1, unitRate: rate(item.equipmentCost) },
  ]);

  const result = calculateProject({
    lineItems,
    overheadPercent: overheadPct,
    markupPercent: markupPct,
  });

  return {
    directCost: result.directCost,
    overheadPercentage: overheadPct,
    overheadAmount: result.overheadAmount,
    costBeforeMarkup: result.costWithOverhead,
    markupPercentage: markupPct,
    markupAmount: result.markupAmount,
    finalPrice: result.finalPrice,
    marginPercentage: result.grossMarginPercent,
  };
}

/**
 * Currency Formatter ($15,993.00 or $15,993)
 */
export function formatCurrency(
  value: number,
  options: { decimals?: number; compact?: boolean } = {}
): string {
  const { decimals = 2, compact = false } = options;
  if (compact && value >= 1000000) {
    return `$${(value / 1000000).toFixed(1)}M`;
  }
  if (compact && value >= 1000) {
    return `$${(value / 1000).toFixed(0)}k`;
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/**
 * Format rounded integer currency (e.g. $15,993 for cards)
 */
export function formatRoundedCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Math.round(value));
}

/**
 * Percentage Formatter
 */
export function formatPercentage(value: number, decimals: number = 1): string {
  return `${value.toFixed(decimals)}%`;
}

/**
 * Formats standard number with commas (e.g., 2,400)
 */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export interface CSICategoryBreakdownRow {
  csiCode: string;
  trade: string;
  directCost: number;
  percentOfTotal: number;
}

/**
 * Calculates breakdown by CSI Category / Trade for the Review table
 */
export function calculateCSICategoryBreakdown(
  items: EstimateItem[],
  totalDirectCost: number
): CSICategoryBreakdownRow[] {
  if (!items || items.length === 0) return [];

  const grouped: Record<
    string,
    { csiCode: string; trade: string; directCost: number }
  > = {};

  items.forEach((item) => {
    const csi = item.csiCode || "01 00 00";
    let tradeName = item.name;
    if (tradeName.includes(" - ")) {
      tradeName = tradeName.split(" - ").slice(1).join(" - ");
    }

    if (!grouped[csi]) {
      grouped[csi] = {
        csiCode: csi,
        trade: tradeName,
        directCost: 0,
      };
    }
    grouped[csi].directCost += calculateLineDirectCost(
      item.materialCost,
      item.laborCost,
      item.equipmentCost
    );
  });

  return Object.values(grouped).map((group) => ({
    ...group,
    directCost: Number(group.directCost.toFixed(2)),
    percentOfTotal:
      totalDirectCost > 0
        ? Number(((group.directCost / totalDirectCost) * 100).toFixed(1))
        : 0,
  }));
}

