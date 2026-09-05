import { calculateProject, type CalculationLineItem, type ProjectCalculationResult } from '../../../../packages/domain/src/index.ts';

export interface PriceableFinding {
  finding_type: string;
  label: string;
  quantity: number | null;
  unit: string | null;
}

export type PricedComponentCategory = 'material' | 'labor';

export interface PricedComponent {
  category: PricedComponentCategory;
  quantity: number;
  unit: string;
  unitRate: number;
  cost: number;
}

export interface PlanPricingSummary {
  /** Priced line items, keyed by the finding's index in the findings array they were derived from. */
  byFindingIndex: Map<number, PricedComponent[]>;
  pricedFindings: number;
  unpricedFindings: number;
  totals: ProjectCalculationResult;
}

interface Rate {
  materialUnitRate: number;
  laborUnitRate: number;
}

/**
 * Fallback per-unit rates used when no material-specific rate is known. These
 * are deliberately conservative placeholders — a workspace price book should
 * override them once one exists. Units are the same short codes the AI plan
 * reader is asked to report (SF, LF, EA, CY, LS, ...).
 */
const UNIT_DEFAULT_RATES: Record<string, Rate> = {
  SF: { materialUnitRate: 4.50, laborUnitRate: 3.25 },
  SY: { materialUnitRate: 38.00, laborUnitRate: 12.00 },
  LF: { materialUnitRate: 6.00, laborUnitRate: 5.00 },
  CY: { materialUnitRate: 145.00, laborUnitRate: 60.00 },
  EA: { materialUnitRate: 25.00, laborUnitRate: 20.00 },
  LS: { materialUnitRate: 350.00, laborUnitRate: 250.00 },
  HR: { materialUnitRate: 0, laborUnitRate: 85.00 },
  SHEET: { materialUnitRate: 55.00, laborUnitRate: 35.00 },
  GAL: { materialUnitRate: 48.00, laborUnitRate: 18.00 },
  BAG: { materialUnitRate: 14.00, laborUnitRate: 6.00 },
  TON: { materialUnitRate: 210.00, laborUnitRate: 90.00 },
};

/**
 * Keyword overrides matched against a finding's label before falling back to
 * the unit default. First match wins; order carries priority.
 */
const LABEL_KEYWORD_RATES: Array<{ pattern: RegExp; rate: Rate }> = [
  { pattern: /composite deck/i, rate: { materialUnitRate: 7.25, laborUnitRate: 4.50 } },
  { pattern: /handrail|baluster|guardrail/i, rate: { materialUnitRate: 24.00, laborUnitRate: 18.00 } },
  { pattern: /drywall|gypsum/i, rate: { materialUnitRate: 1.35, laborUnitRate: 1.65 } },
  { pattern: /insulation/i, rate: { materialUnitRate: 0.95, laborUnitRate: 0.55 } },
  { pattern: /primer|paint/i, rate: { materialUnitRate: 0.55, laborUnitRate: 0.85 } },
  { pattern: /vapor barrier|moisture retarder|underlayment/i, rate: { materialUnitRate: 0.40, laborUnitRate: 0.35 } },
  { pattern: /concrete|footing|slab|foundation/i, rate: { materialUnitRate: 165.00, laborUnitRate: 95.00 } },
  { pattern: /framing|stud|joist|post base|hanger/i, rate: { materialUnitRate: 3.75, laborUnitRate: 4.25 } },
  { pattern: /electrical|wiring|outlet|circuit|panel/i, rate: { materialUnitRate: 45.00, laborUnitRate: 95.00 } },
  { pattern: /plumbing|pipe|fixture|drain/i, rate: { materialUnitRate: 65.00, laborUnitRate: 110.00 } },
  { pattern: /roof|shingle|flashing/i, rate: { materialUnitRate: 3.25, laborUnitRate: 2.75 } },
  { pattern: /flooring|tile/i, rate: { materialUnitRate: 5.50, laborUnitRate: 4.00 } },
  { pattern: /window|door/i, rate: { materialUnitRate: 320.00, laborUnitRate: 180.00 } },
  { pattern: /demolition|demo/i, rate: { materialUnitRate: 0, laborUnitRate: 75.00 } },
];

function resolveRate(label: string, unit: string): Rate | null {
  const keyword = LABEL_KEYWORD_RATES.find(({ pattern }) => pattern.test(label));
  if (keyword) return keyword.rate;
  return UNIT_DEFAULT_RATES[unit.trim().toUpperCase()] ?? null;
}

function isPriceableQuantity(quantity: number | null): quantity is number {
  return typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0 && quantity < 1e12;
}

/**
 * Turns AI plan-reading findings into priced material and labor line items
 * using calculateProject, the same fixed-point pricing engine estimates use.
 * A `material` finding produces both a material line (its own quantity at the
 * material rate) and a companion install-labor line at the same quantity, so
 * every material carries its own labor cost. A `labor` finding — a service or
 * task the plan implies rather than a physical good — produces a single labor
 * line. Findings that are missing a quantity/unit or match no known rate are
 * left unpriced rather than guessed at.
 */
export function priceFindings(findings: readonly PriceableFinding[]): PlanPricingSummary {
  const lineItems: CalculationLineItem[] = [];
  const byFindingIndex = new Map<number, PricedComponent[]>();
  let pricedFindings = 0;
  let unpricedFindings = 0;

  findings.forEach((finding, index) => {
    if (finding.finding_type !== 'material' && finding.finding_type !== 'labor') return;
    const unit = finding.unit?.trim();
    if (!isPriceableQuantity(finding.quantity) || !unit) { unpricedFindings += 1; return; }
    const rate = resolveRate(finding.label, unit);
    if (!rate) { unpricedFindings += 1; return; }

    const quantity = finding.quantity;
    const components: PricedComponent[] = [];

    if (finding.finding_type === 'material') {
      if (rate.materialUnitRate > 0) {
        const id = `finding-${index}-material`;
        lineItems.push({ id, category: 'material', quantity, unitRate: rate.materialUnitRate });
        components.push({ category: 'material', quantity, unit, unitRate: rate.materialUnitRate, cost: quantity * rate.materialUnitRate });
      }
      if (rate.laborUnitRate > 0) {
        const id = `finding-${index}-install-labor`;
        lineItems.push({ id, category: 'labor', quantity, unitRate: rate.laborUnitRate });
        components.push({ category: 'labor', quantity, unit, unitRate: rate.laborUnitRate, cost: quantity * rate.laborUnitRate });
      }
    } else if (rate.laborUnitRate > 0) {
      const id = `finding-${index}-labor`;
      lineItems.push({ id, category: 'labor', quantity, unitRate: rate.laborUnitRate });
      components.push({ category: 'labor', quantity, unit, unitRate: rate.laborUnitRate, cost: quantity * rate.laborUnitRate });
    }

    if (components.length) {
      byFindingIndex.set(index, components);
      pricedFindings += 1;
    } else {
      unpricedFindings += 1;
    }
  });

  const totals = calculateProject({ lineItems, overheadPercent: 0, markupPercent: 0 });
  return { byFindingIndex, pricedFindings, unpricedFindings, totals };
}
