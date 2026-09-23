import React from "react";
import {
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Project } from "../types";
import {
  calculateProjectFinancials,
  calculateCSICategoryBreakdown,
  formatCurrency,
  formatPercentage,
} from "../utils/calculations";
import { Stepper } from "../components/Stepper";
import { ProjectStep } from "../components/Header";
import { projectReadiness } from "../utils/projectReadiness";

interface ReviewPageProps {
  project: Project;
  onContinue: () => void;
  onBack: () => void;
  onSelectStep: (step: ProjectStep) => void;
  onOpenAIAssistant: () => void;
}

export const ReviewPage: React.FC<ReviewPageProps> = ({
  project,
  onContinue,
  onBack,
  onSelectStep,
  onOpenAIAssistant,
}) => {
  const financials = calculateProjectFinancials(
    project.estimateItems,
    project.overheadPercentage,
    project.markupPercentage
  );

  const breakdown = calculateCSICategoryBreakdown(
    project.estimateItems,
    financials.directCost
  );

  const currentRevision =
    project.revisions.find((r) => r.isCurrent) || project.revisions[0];
  const readiness = projectReadiness(project);
  const readinessItems = [
    {
      label: currentRevision
        ? `Plan uploaded: Rev ${currentRevision.revisionNumber}`
        : "Upload a plan before proposal export",
      done: readiness.hasPlan,
    },
    {
      label: `${project.quantities.length} takeoff items recorded`,
      done: readiness.hasQuantities,
    },
    {
      label: readiness.hasEstimate ? `${project.estimateItems.length} estimate lines priced` : "Enter your costs for every estimate line",
      done: readiness.hasEstimate,
    },
    {
      label: "Overhead and markup settings are present",
      done: readiness.hasSettings,
    },
  ];
  const readyCount = readinessItems.filter((item) => item.done).length;
  const isReady = readyCount === readinessItems.length;

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-6xl mx-auto space-y-6 select-none font-sans">
      {/* Title & Subtitle */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
            Review
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Review your estimate breakdown and verify audit readiness before exporting.
          </p>
        </div>

        <button
          onClick={onOpenAIAssistant}
          className="self-start sm:self-auto flex items-center gap-1.5 px-3 py-1.5 bg-brand-50 border border-blue-200 text-brand-500 hover:bg-blue-100 rounded-md text-xs font-semibold transition cursor-pointer shadow-xs"
        >
          <Sparkles className="w-3.5 h-3.5 text-brand-500" />
          <span>Audit Consistency</span>
        </button>
      </div>

      {/* Stepper timeline */}
      <Stepper currentStep="review" onSelectStep={onSelectStep} />

      {/* Top 4 Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
        {/* Direct Cost */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 shadow-xs">
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
            DIRECT COST
          </span>
          <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
            {formatCurrency(financials.directCost)}
          </div>
          <span className="text-[11px] text-slate-400 mt-1 block">
            Material, labor & equipment
          </span>
        </div>

        {/* Overhead */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 shadow-xs">
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
            OVERHEAD ({financials.overheadPercentage}%)
          </span>
          <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
            {formatCurrency(financials.overheadAmount)}
          </div>
          <span className="text-[11px] text-slate-400 mt-1 block">
            Operational project costs
          </span>
        </div>

        {/* Markup */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 shadow-xs">
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
            MARKUP ({financials.markupPercentage}%)
          </span>
          <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
            {formatCurrency(financials.markupAmount)}
          </div>
          <span className="text-[11px] text-emerald-600 font-semibold mt-1 block">
            {formatPercentage(financials.marginPercentage)} gross margin
          </span>
        </div>

        {/* Final Price */}
        <div className="bg-brand-50 border border-blue-200 rounded-xl p-4 sm:p-5 shadow-xs">
          <span className="text-[10px] font-bold text-brand-500 uppercase tracking-wider block">
            FINAL PRICE
          </span>
          <div className="text-xl font-bold text-brand-500 mt-1 font-mono">
            {formatCurrency(financials.finalPrice)}
          </div>
          <span className="text-[11px] text-brand-700 font-semibold mt-1 block">
            Total contract price
          </span>
        </div>
      </div>

      {/* Main Review Grid: Trade Breakdown Table + Scope Verification */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: Breakdown by CSI Category / Trade */}
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
          <div className="p-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
              Breakdown by CSI Category / Trade
            </h3>
            <span className="text-xs text-slate-500 font-medium">
              {project.estimateItems.length} line items total
            </span>
          </div>

          <div className="sm:hidden divide-y divide-slate-100">
            {breakdown.length === 0 ? <p className="p-4 text-xs text-slate-500">No estimate lines added.</p> : breakdown.map(row => (
              <div key={row.csiCode} className="p-4 space-y-2">
                <p className="text-[10px] font-mono text-slate-500">{row.csiCode}</p>
                <p className="text-sm font-semibold text-slate-900 break-words">{row.trade}</p>
                <div className="flex justify-between text-sm">
                  <span className="font-mono font-semibold">{formatCurrency(row.directCost)}</span>
                  <span className="text-slate-500">{formatPercentage(row.percentOfTotal)} of total</span>
                </div>
              </div>
            ))}
          </div>
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-left text-xs min-w-[320px]">
              <thead className="bg-slate-50 text-slate-500 font-bold text-[10px] uppercase tracking-wider border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4">CSI CODE</th>
                  <th className="py-3 px-4">TRADE</th>
                  <th className="py-3 px-4 text-right">DIRECT COST</th>
                  <th className="py-3 px-4 text-right">% OF TOTAL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {breakdown.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-slate-400">
                      No estimate lines added.
                    </td>
                  </tr>
                ) : (
                  breakdown.map((row) => (
                    <tr key={row.csiCode} className="hover:bg-slate-50 transition">
                      <td className="py-3 px-4 font-mono font-semibold text-slate-600 text-xs">
                        {row.csiCode}
                      </td>
                      <td className="py-3 px-4 font-bold text-slate-900">
                        {row.trade}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-semibold text-slate-900">
                        {formatCurrency(row.directCost)}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="w-12 sm:w-16 bg-slate-100 rounded-full h-1.5 overflow-hidden">
                            <div
                              className="bg-brand-500 h-full rounded-full"
                              style={{ width: `${Math.min(row.percentOfTotal, 100)}%` }}
                            />
                          </div>
                          <span className="font-mono font-medium text-slate-600 text-xs w-10 sm:w-12 text-right">
                            {formatPercentage(row.percentOfTotal)}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right 1 Col: Quality Checklist & Plan Sync Card */}
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs space-y-3.5">
            <h3 className="text-xs font-bold text-slate-900 flex items-center gap-2 uppercase tracking-wider">
              <ShieldCheck className="w-4 h-4 text-brand-500" />
              <span>Project Audit Checklist</span>
            </h3>

            <div className="space-y-2.5 text-xs">
              {readinessItems.map((item) => (
                <div key={item.label} className="flex items-start gap-2.5">
                  <CheckCircle2 className={`w-4 h-4 shrink-0 mt-0.5 ${item.done ? "text-emerald-600" : "text-slate-400"}`} />
                  <span className={item.done ? "text-slate-600" : "text-slate-500"}>
                    {item.label}
                  </span>
                </div>
              ))}
            </div>

            <div className="pt-2 border-t border-slate-100">
              <div className={`p-3 rounded-lg text-xs leading-relaxed ${isReady ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>
                <strong className={isReady ? "text-emerald-900" : "text-amber-900"}>Readiness Status:</strong>{" "}
                {isReady
                  ? "Ready for estimator review and export."
                  : `${readyCount}/${readinessItems.length} checks complete. Finish the missing items before client delivery.`}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Navigation Buttons */}
      <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-4 border-t border-slate-200">
        <button
          onClick={onBack}
          className="flex items-center justify-center gap-2 px-4 py-2 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md text-xs font-medium transition cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Estimate</span>
        </button>

        <button
          onClick={onContinue}
          className="flex items-center justify-center gap-2 px-5 py-2.5 bg-brand-500 hover:bg-brand-700 text-white rounded-md text-xs font-semibold transition shadow-xs cursor-pointer w-full sm:w-auto"
        >
          <span>Continue to Export</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
