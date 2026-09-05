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
 * New England (CT/MA/ME/NH/RI/VT) benchmark rates — 48" frost-line concrete,
 * IECC zone 5/6 thermal envelopes, cold-climate MEP, and prevailing
 * Northeast trade labor scales, matching docs/architecture's
 * "New England ML Method". Source figures are *total installed* costs per
 * unit (material + labor together); this table only ever tracks a single
 * material rate per keyword, so each is split into a material share and a
 * labor share using typical published trade cost-breakdown ratios (documented
 * per line below) — an estimate of the split, not an exact one, same as any
 * unit-cost benchmark. Equipment-heavy MEP items (a heat pump, a service
 * panel) skew toward material since the hardware itself dominates the cost.
 */
const NEW_ENGLAND_LABOR_HOURLY: Record<string, number> = {
  electrician: 135.00,
  plumber: 140.00,
  hvac: 130.00,
  framer: 95.00,
  concrete: 85.00,
  insulation: 75.00,
  drywall: 70.00,
  laborer: 58.00,
};

/**
 * installed: total installed $/unit. materialShare: material's share of that
 * total (0..1). Rounds material to the nearest cent first and gives labor
 * the remainder, so the two always sum back to the installed rate exactly —
 * rounding each share independently can overshoot the total by a cent.
 */
const split = (installed: number, materialShare: number): Rate => {
  const totalCents = Math.round(installed * 100);
  const materialCents = Math.round(totalCents * materialShare);
  return { materialUnitRate: materialCents / 100, laborUnitRate: (totalCents - materialCents) / 100 };
};

/**
 * Keyword overrides matched against a finding's label before falling back to
 * the unit default. First match wins; order carries priority.
 */
const LABEL_KEYWORD_RATES: Array<{ pattern: RegExp; rate: Rate }> = [
  { pattern: /composite deck/i, rate: { materialUnitRate: 7.25, laborUnitRate: 4.50 } },
  { pattern: /handrail|baluster|guardrail/i, rate: { materialUnitRate: 24.00, laborUnitRate: 18.00 } },
  // 03 concrete — forms/placement/finishing are labor-heavy: 45% material / 55% labor.
  { pattern: /footing/i, rate: split(265.00, 0.45) }, // NE: 4000 PSI continuous footings, 48" frost line, per CY
  { pattern: /foundation wall/i, rate: split(18.50, 0.45) }, // NE: 8" formed cast-in-place foundation wall, per SF
  { pattern: /concrete|slab/i, rate: split(8.20, 0.45) }, // NE: 4" slab on grade w/ vapor barrier, per SF
  // 06 framing — roughly even split.
  { pattern: /2x6|exterior.*(stud|wall)|load-bearing/i, rate: split(16.50, 0.55) }, // NE: 2x6 ext framing + CDX sheathing, per SF wall area
  { pattern: /2x4|interior partition/i, rate: split(32.00, 0.55) }, // NE: 2x4 interior partition framing, per LF
  { pattern: /i-joist|floor truss|lvl/i, rate: split(14.50, 0.55) }, // NE: engineered I-joist/LVL floor system, per SF
  { pattern: /roof truss/i, rate: split(11.50, 0.55) }, // NE: pre-engineered roof trusses, per SF footprint
  { pattern: /framing|stud|joist|post base|hanger/i, rate: split(16.50, 0.55) }, // generic framing fallback
  // 07 thermal envelope — material (board/foam/shingle) dominates: 60% material / 40% labor.
  { pattern: /rigid|polyiso|continuous insulation/i, rate: split(3.80, 0.6) }, // NE: 2" continuous polyiso R-13, per SF
  { pattern: /spray ?foam/i, rate: split(5.20, 0.6) }, // NE: closed-cell spray foam 3", per SF
  { pattern: /shingle|ice.*water|roof(?!.*truss)/i, rate: split(6.85, 0.6) }, // NE: architectural shingles + ice/water shield, per SF (from $685/SQ)
  { pattern: /insulation/i, rate: split(3.80, 0.6) }, // generic insulation fallback
  // 22/23 MEP — equipment/fixture dominated: 65% material / 35% labor.
  { pattern: /heat pump|hvac equipment/i, rate: split(18500.00, 0.65) }, // NE: cold-climate inverter heat pump installed, per EA system
  { pattern: /plumbing|pipe|fixture|drain|lavatory|vanity/i, rate: split(1850.00, 0.5) }, // NE: PEX-A rough-in per fixture, per EA
  { pattern: /electrical|wiring|outlet|circuit|panel|service/i, rate: split(6200.00, 0.65) }, // NE: 200A main service panel installed, per EA
  { pattern: /duct/i, rate: { materialUnitRate: 4.20, laborUnitRate: 2.80 } }, // insulated flex ductwork, per LF
  // 09 finishes — hang/tape/finish labor dominates: 40% material / 60% labor.
  { pattern: /drywall|gypsum/i, rate: split(4.10, 0.4) }, // NE: 5/8" Type X drywall, Level 4 finish, per SF
  { pattern: /primer|paint/i, rate: { materialUnitRate: 0.55, laborUnitRate: 0.85 } },
  { pattern: /vapor barrier|moisture retarder|underlayment/i, rate: { materialUnitRate: 0.40, laborUnitRate: 0.35 } },
  { pattern: /flooring|tile/i, rate: { materialUnitRate: 5.50, laborUnitRate: 4.00 } },
  { pattern: /window|door/i, rate: { materialUnitRate: 320.00, laborUnitRate: 180.00 } },
  { pattern: /demolition|demo/i, rate: { materialUnitRate: 0, laborUnitRate: NEW_ENGLAND_LABOR_HOURLY.laborer! } },
  // Standalone labor/service findings by trade — Northeast prevailing hourly scales.
  { pattern: /electrician|electrical (rough|labor)/i, rate: { materialUnitRate: 0, laborUnitRate: NEW_ENGLAND_LABOR_HOURLY.electrician! } },
  { pattern: /plumber|plumbing (rough|labor)/i, rate: { materialUnitRate: 0, laborUnitRate: NEW_ENGLAND_LABOR_HOURLY.plumber! } },
  { pattern: /hvac (tech|labor|install)/i, rate: { materialUnitRate: 0, laborUnitRate: NEW_ENGLAND_LABOR_HOURLY.hvac! } },
  { pattern: /framing (labor|carpenter)/i, rate: { materialUnitRate: 0, laborUnitRate: NEW_ENGLAND_LABOR_HOURLY.framer! } },
  { pattern: /concrete (labor|finisher|formwork)/i, rate: { materialUnitRate: 0, laborUnitRate: NEW_ENGLAND_LABOR_HOURLY.concrete! } },
  { pattern: /insulation (labor|install|tech)/i, rate: { materialUnitRate: 0, laborUnitRate: NEW_ENGLAND_LABOR_HOURLY.insulation! } },
  { pattern: /drywall (labor|taper|hang)/i, rate: { materialUnitRate: 0, laborUnitRate: NEW_ENGLAND_LABOR_HOURLY.drywall! } },
  { pattern: /general labor|laborer|clean ?up/i, rate: { materialUnitRate: 0, laborUnitRate: NEW_ENGLAND_LABOR_HOURLY.laborer! } },
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
