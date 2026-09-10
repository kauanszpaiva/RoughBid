import React from "react";
import { AlertTriangle, CheckCircle2, FileStack, ListChecks } from "lucide-react";
import { summarizeTakeoffCoverage, type TakeoffV2Coverage } from "../utils/takeoffCoverage";

export function TakeoffCoverageDashboard({ coverage }: { coverage: TakeoffV2Coverage }) {
  const metrics = summarizeTakeoffCoverage(coverage);

  return (
    <section aria-label="Full takeoff coverage" className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-xs font-bold text-slate-900">Full Takeoff V2 coverage</h4>
          <p className="mt-0.5 text-[11px] text-slate-600">Every physical sheet and analysis pass must reconcile before release.</p>
        </div>
        <span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase ${
          metrics.canRelease ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"
        }`}>
          {metrics.canRelease ? "Release verified" : "Release blocked"}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Metric icon={<FileStack className="h-4 w-4" />} label="Sheets accounted" value={`${metrics.accountedPages}/${metrics.physicalPages}`} />
        <Metric icon={<ListChecks className="h-4 w-4" />} label="Passes complete" value={`${metrics.completedPasses}/${metrics.totalPasses}`} />
        <Metric icon={metrics.blockerCount ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />} label="Blockers" value={String(metrics.blockerCount)} warning={metrics.blockerCount > 0} />
      </div>

      <div className="space-y-1.5">
        {coverage.sheets.map((sheet) => (
          <div key={sheet.physicalPageNumber} className="rounded border border-slate-200 bg-white px-2.5 py-2">
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="font-semibold text-slate-800">Physical sheet {sheet.physicalPageNumber}</span>
              <span className="text-slate-600">{sheet.status.replaceAll("_", " ")} · {sheet.passesCompleted}/{sheet.passesTotal} passes</span>
            </div>
            {sheet.blockers.length > 0 && <ul className="mt-1 list-disc pl-4 text-[10px] text-amber-900">{sheet.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
          </div>
        ))}
      </div>
    </section>
  );
}

function Metric({ icon, label, value, warning = false }: { icon: React.ReactNode; label: string; value: string; warning?: boolean }) {
  return (
    <div className={`flex items-center gap-2 rounded border bg-white p-2 ${warning ? "border-amber-300 text-amber-900" : "border-slate-200 text-slate-700"}`}>
      {icon}
      <div><div className="text-[10px] uppercase tracking-wide">{label}</div><div className="text-sm font-bold">{value}</div></div>
    </div>
  );
}
