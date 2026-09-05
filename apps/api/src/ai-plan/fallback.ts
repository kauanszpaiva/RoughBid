import { sanitizePlanReadingResult, type PlanReadingResult } from './types.ts';

/**
 * Trade-shaped placeholder findings (adapted from a working reference
 * implementation) used only when no AI provider is available or all of them
 * failed, so the estimator always has a starting checklist instead of a hard
 * error. Shared by every reader (Gemini, and the Groq/Cerebras image
 * providers) as the last resort in the fallback chain — never returned
 * without `synthetic: true` so callers know to disclose it clearly.
 */
function generateDeterministicTakeoff(requestedTrades: readonly string[]) {
  const TRADE_TEMPLATES: Record<string, Array<{ label: string; quantity: number; unit: string; confidence: number; source_excerpt: string }>> = {
    Framing: [
      { label: '2x6 Exterior Load-Bearing Stud Wall (16" O.C.)', quantity: 96, unit: 'LF', confidence: 0.6, source_excerpt: 'Ref Sheet A-101 / Wall Type W1 perimeter dimension string' },
      { label: '11-7/8" Engineered Wood I-Joists @ 16" O.C.', quantity: 48, unit: 'LF', confidence: 0.55, source_excerpt: 'Structural Framing Plan S-101 gridlines A to C' },
    ],
    Concrete: [
      { label: 'Monolithic 4" 3500 PSI Slab on Grade with Rebar', quantity: 18, unit: 'CY', confidence: 0.6, source_excerpt: 'Detail 3/S-501 slab over vapor barrier and crushed stone' },
    ],
    Drywall: [
      { label: '5/8" Type X Gypsum Wallboard (Level 4 Finish)', quantity: 2850, unit: 'SF', confidence: 0.6, source_excerpt: 'Partition Specs 09 29 00 Firecode Type X board' },
    ],
    Electrical: [
      { label: '6" Recessed IC-Rated Airtight LED Downlights', quantity: 14, unit: 'EA', confidence: 0.6, source_excerpt: 'Reflected Ceiling Plan RCP-101 Type D1 fixtures' },
    ],
    Plumbing: [
      { label: 'Dual-Vanity Lavatory Rough-in & Fixture Trim', quantity: 2, unit: 'EA', confidence: 0.6, source_excerpt: 'Plumbing Fixture Schedule P-101 Mark P-1' },
    ],
    HVAC: [
      { label: 'R-8 Flexible Insulated Supply & Return Ductwork', quantity: 160, unit: 'LF', confidence: 0.55, source_excerpt: 'Mechanical Plan M-101 8" dia R-8 flex duct' },
    ],
    Finishes: [
      { label: 'White Oak Engineered Hardwood Flooring (5" Plank)', quantity: 564, unit: 'SF', confidence: 0.6, source_excerpt: 'Finish Schedule Room 104 Finish F-1' },
    ],
  };

  const trades = requestedTrades.length ? requestedTrades : Object.keys(TRADE_TEMPLATES);
  const findings: Array<Record<string, unknown>> = [];
  for (const trade of trades) {
    const list = TRADE_TEMPLATES[trade] ?? [{ label: `${trade} Scope Assembly Allocation`, quantity: 1, unit: 'LS', confidence: 0.5, source_excerpt: `General notes: ${trade} requirements` }];
    for (const item of list) {
      findings.push({ ...item, page_number: 1, finding_type: 'material', value_text: `${item.quantity} ${item.unit}` });
    }
    findings.push({
      page_number: 1,
      finding_type: 'labor',
      label: `${trade} Installation Labor`,
      value_text: null,
      quantity: 1,
      unit: 'LS',
      confidence: 0.5,
      source_excerpt: `General notes: ${trade} scope requires licensed trade labor`,
    });
  }

  return {
    summary: { sheet_count: 1, detected_trade_scope: trades, scale_status: 'detected' },
    findings,
  };
}

/** Builds a validated, clearly-labeled synthetic result — the shared last resort every reader falls back to. */
export function syntheticPlanReadingResult(requestedTrades: readonly string[], notice: string): PlanReadingResult {
  return sanitizePlanReadingResult(generateDeterministicTakeoff(requestedTrades), [notice], true);
}
