import type { PlanReadingFinding } from '../../../services/api';
import { groupAiFindingsByArea } from '../../../utils/aiFindingReview';

export type TakeoffPanelProps = {
  findings: PlanReadingFinding[];
  onSelectFinding: (findingId: string) => void;
};

function hasSourcePricing(finding: PlanReadingFinding): boolean {
  return Array.isArray(finding.geometry?.pricing) && finding.geometry.pricing.length > 0;
}

export function TakeoffPanel({ findings, onSelectFinding }: TakeoffPanelProps) {
  const groups = groupAiFindingsByArea(findings);

  return (
    <section aria-label="Area takeoff report" className="min-h-0 overflow-y-auto p-3">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-slate-900">Takeoff</h3>
        <p className="mt-1 text-[11px] text-slate-500">Existing AI evidence grouped by area. Quantities and costs still require estimator review.</p>
      </div>
      <div className="space-y-3">
        {groups.map(group => (
          <section key={group.areaName} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <header className="border-b border-slate-200 bg-slate-50 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <strong className="truncate text-xs text-slate-900">{group.areaName}</strong>
                <span className="text-[10px] text-slate-500">{group.findings.length} findings</span>
              </div>
              {group.pages.size > 0 && <p className="mt-0.5 text-[10px] text-slate-500">Pages {[...group.pages].sort((a, b) => a - b).join(', ')}</p>}
            </header>
            <div className="divide-y divide-slate-100">
              {group.findings.map(finding => (
                <button key={finding.id} type="button" onClick={() => onSelectFinding(finding.id)} className="w-full p-3 text-left hover:bg-slate-50" aria-label={`Open takeoff source ${finding.label}`}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-medium text-slate-800">{finding.label}</span>
                    {finding.quantity !== null && <span className="shrink-0 text-xs font-semibold tabular-nums text-slate-700">{finding.quantity} {finding.unit ?? ''}</span>}
                  </div>
                  <p className="mt-1 text-[10px] text-slate-500">{finding.page_number ? `Page ${finding.page_number}` : 'Source page unknown'}</p>
                  <p className={`mt-1 text-[10px] font-medium ${hasSourcePricing(finding) ? 'text-amber-700' : 'text-slate-500'}`}>{hasSourcePricing(finding) ? 'Source pricing present - review required' : 'Costs not configured'}</p>
                </button>
              ))}
            </div>
          </section>
        ))}
        {groups.length === 0 && <p className="rounded-lg border border-dashed border-slate-200 p-5 text-center text-xs text-slate-500">No takeoff evidence yet.</p>}
      </div>
    </section>
  );
}
