import React from "react";
import {
  ArrowUpRight,
  CircleDot,
  FileSearch,
  FolderOpen,
  Plus,
  Send,
  Sparkles,
} from "lucide-react";
import { Project } from "../types";
import { calculateProjectFinancials, formatRoundedCurrency } from "../utils/calculations";

interface DashboardPageProps {
  canWrite?: boolean;
  projects: Project[];
  onOpenProject: (project: Project) => void;
  onNewProject: () => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ projects, onOpenProject, onNewProject, canWrite = false }) => {
  const activeBidsCount = projects.filter((project) => project.status === "In Progress").length;
  const readyToSendCount = projects.filter((project) => project.estimateItems.length > 0 && project.revisions.length > 0).length;
  const plansInAiQueue = projects.reduce((sum, project) => sum + project.revisions.filter((revision) =>
    [revision.processingStatus, revision.aiPlanStatus].some((status) => status === "queued" || status === "processing"),
  ).length, 0);
  const needsPricing = projects.filter((project) => project.revisions.length > 0 && project.estimateItems.length === 0).length;
  const totalPipeline = projects.reduce((sum, project) => sum + calculateProjectFinancials(
    project.estimateItems,
    project.overheadPercentage,
    project.markupPercentage,
  ).finalPrice, 0);
  const averageMargin = projects.length
    ? projects.reduce((sum, project) => sum + calculateProjectFinancials(
        project.estimateItems,
        project.overheadPercentage,
        project.markupPercentage,
      ).marginPercentage, 0) / projects.length
    : 0;
  const priorityProjects = projects.filter((project) => project.status !== "Completed").slice(0, 5);
  const formatPipeline = (amount: number) => amount >= 1000000
    ? `$${(amount / 1000000).toFixed(1)}M`
    : amount >= 1000 ? `$${Math.round(amount / 1000)}K` : `$${Math.round(amount)}`;

  return (
    <div className="min-h-full bg-slate-50">
      <div className="mx-auto max-w-[1400px] space-y-6 px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
        <header className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-700">Bid control workspace</p>
            <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-slate-900">
              Build the bid. <span className="text-slate-500">Know the margin.</span>
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
              Plans, quantities, pricing and review, held in one accountable estimating record.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 shadow-sm">
              <CircleDot className="h-3.5 w-3.5 text-emerald-600" />
              Synced now
            </span>
            <button
              onClick={onNewProject}
              disabled={!canWrite}
              className="group inline-flex items-center justify-center gap-2 rounded-lg bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              New project
              <Plus className="h-4 w-4 transition-transform group-hover:rotate-90" />
            </button>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Total pipeline</p>
            <p className="mt-3 font-display text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">{formatPipeline(totalPipeline)}</p>
            <p className="mt-2 text-xs text-slate-500">
              Across {projects.length} saved project{projects.length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Average margin</p>
            <p className="mt-3 font-display text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
              {averageMargin.toFixed(1)}<span className="text-2xl">%</span>
            </p>
            <p className="mt-2 text-xs text-slate-500">
              {activeBidsCount} active bid{activeBidsCount === 1 ? "" : "s"} in progress
            </p>
          </div>
        </section>

        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: "Plans to price", value: needsPricing, detail: "Drawings without estimate lines", icon: FileSearch },
            { label: "Ready to issue", value: readyToSendCount, detail: "Reviewed and client-ready", icon: Send },
            { label: "Reading queue", value: plansInAiQueue, detail: "Plan jobs in progress", icon: Sparkles },
            { label: "Active bids", value: activeBidsCount, detail: "Projects still open", icon: CircleDot },
          ].map(({ label, value, detail, icon: Icon }) => (
            <div key={label} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <span className="text-xs font-semibold text-slate-600">{label}</span>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                  <Icon className="h-4 w-4" strokeWidth={1.75} />
                </span>
              </div>
              <p className="mt-4 font-display text-3xl font-semibold tracking-tight text-slate-900">{value.toString().padStart(2, "0")}</p>
              <p className="mt-1 text-xs text-slate-500">{detail}</p>
            </div>
          ))}
        </section>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,0.6fr)]">
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 px-5 py-4 sm:px-6">
              <div>
                <h2 className="font-display text-lg font-semibold tracking-tight text-slate-900">Priority bids</h2>
                <p className="mt-0.5 text-xs text-slate-500">Open projects, ready for the next decision</p>
              </div>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">
                {priorityProjects.length} record{priorityProjects.length === 1 ? "" : "s"}
              </span>
            </div>

            {priorityProjects.length === 0 ? (
              <div className="flex min-h-40 flex-col items-start justify-center gap-3 px-5 py-10 sm:px-6">
                <FolderOpen className="h-8 w-8 text-slate-400" strokeWidth={1.5} />
                <div>
                  <p className="font-display text-lg font-semibold text-slate-900">The work stack is clear.</p>
                  <p className="mt-1 text-sm text-slate-600">Start a project to create the first estimating record.</p>
                </div>
              </div>
            ) : (
              <div className="divide-y divide-slate-200">
                {priorityProjects.map((project, index) => {
                  const financials = calculateProjectFinancials(project.estimateItems, project.overheadPercentage, project.markupPercentage);
                  return (
                    <button
                      key={project.id}
                      onClick={() => onOpenProject(project)}
                      className="group grid w-full grid-cols-[32px_minmax(0,1fr)_auto_20px] items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-slate-50 sm:px-6"
                    >
                      <span className="font-mono text-[11px] text-slate-400">{String(index + 1).padStart(2, "0")}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-slate-900">{project.name}</span>
                        <span className="mt-0.5 block truncate text-xs text-slate-500">{project.address || "Address not set"}</span>
                      </span>
                      <span className="text-right">
                        <span className="block font-mono text-sm font-semibold text-slate-900">{financials.finalPrice > 0 ? formatRoundedCurrency(financials.finalPrice) : "—"}</span>
                        <span className="mt-0.5 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">{project.status}</span>
                      </span>
                      <ArrowUpRight className="h-4 w-4 text-slate-400 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-brand-700" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <aside className="flex flex-col rounded-xl bg-slate-900 p-6 text-white shadow-sm">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-brand-300">Five stages</p>
            <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight">From sheet to signature.</h2>
            <ol className="mt-6 border-t border-white/10">
              {["Plan set", "Quantity takeoff", "Cost build", "Estimator review", "Client issue"].map((step, index) => (
                <li key={step} className="flex items-center gap-3 border-b border-white/10 py-3.5">
                  <span className={`font-mono text-[10px] ${index === 0 ? "text-brand-300" : "text-white/40"}`}>0{index + 1}</span>
                  <span className="text-sm font-medium">{step}</span>
                  {index === 0 && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-brand-300" />}
                </li>
              ))}
            </ol>
            <p className="mt-6 text-xs leading-5 text-white/50">Every stage preserves the evidence behind the number. No black-box totals.</p>
          </aside>
        </section>
      </div>
    </div>
  );
};
