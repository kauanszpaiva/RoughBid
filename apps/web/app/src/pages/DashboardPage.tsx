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
    <div className="min-h-full bg-[#f1efe8] text-[#151713] rb-grid">
      <div className="mx-auto max-w-[1500px] px-5 py-8 sm:px-8 lg:px-12 lg:py-12">
        <section className="grid border-y border-[#151713] lg:grid-cols-[minmax(0,1.45fr)_minmax(280px,.55fr)]">
          <div className="py-9 pr-0 lg:border-r lg:border-[#151713] lg:py-14 lg:pr-12">
            <div className="mb-8 flex items-center gap-3 font-mono text-[10px] font-semibold uppercase tracking-[.2em]">
              <span className="bg-[#151713] px-2 py-1 text-[#d9ff43]">Ops / Live</span>
              <span className="text-[#65685f]">Bid control workspace</span>
            </div>
            <h1 className="font-display max-w-4xl text-[clamp(3rem,7vw,6.8rem)] font-semibold leading-[.84] tracking-[-.075em]">
              Build the bid.<br /><span className="text-[#6d7167]">Know the margin.</span>
            </h1>
            <div className="mt-9 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
              <p className="max-w-xl text-sm leading-6 text-[#555950] sm:text-base">
                Plans, quantities, pricing, and review—held in one accountable estimating record.
              </p>
              <button
                onClick={onNewProject}
                disabled={!canWrite}
                className="group inline-flex min-h-12 items-center justify-between gap-8 border border-[#151713] bg-[#d9ff43] px-5 font-mono text-xs font-semibold uppercase tracking-[.12em] transition-all hover:-translate-x-1 hover:-translate-y-1 hover:bg-[#151713] hover:text-[#d9ff43] disabled:cursor-not-allowed disabled:opacity-40"
              >
                New project <Plus className="h-4 w-4 transition-transform group-hover:rotate-90" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 border-t border-[#151713] lg:grid-cols-1 lg:border-t-0">
            <div className="flex flex-col justify-between border-r border-b border-[#151713] p-6 lg:border-r-0 lg:p-8">
              <span className="font-mono text-[10px] uppercase tracking-[.18em] text-[#65685f]">01 / Pipeline</span>
              <strong className="font-display mt-8 text-5xl tracking-[-.06em] lg:text-6xl">{formatPipeline(totalPipeline)}</strong>
            </div>
            <div className="flex flex-col justify-between border-b border-[#151713] p-6 lg:p-8">
              <span className="font-mono text-[10px] uppercase tracking-[.18em] text-[#65685f]">02 / Avg margin</span>
              <strong className="font-display mt-8 text-5xl tracking-[-.06em] lg:text-6xl">{averageMargin.toFixed(1)}<small className="text-xl">%</small></strong>
            </div>
            <div className="col-span-2 flex items-center justify-between p-5 font-mono text-[11px] uppercase tracking-[.12em] lg:col-span-1 lg:px-8">
              <span>{activeBidsCount.toString().padStart(2, "0")} active bids</span>
              <span className="flex items-center gap-2"><CircleDot className="h-3.5 w-3.5 text-[#789300]" /> Synced now</span>
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 border-b border-[#151713]">
          {[
            { code: "A01", label: "Plans to price", value: needsPricing, detail: "Drawings without estimate lines", icon: FileSearch },
            { code: "A02", label: "Ready to issue", value: readyToSendCount, detail: "Reviewed and client-ready", icon: Send },
            { code: "A03", label: "Reading queue", value: plansInAiQueue, detail: "Plan jobs in progress", icon: Sparkles },
          ].map(({ code, label, value, detail, icon: Icon }, index) => (
            <div key={code} className={`group p-6 transition-colors hover:bg-[#e7e5dc] lg:p-8 ${index < 2 ? "border-b border-[#151713] sm:border-b-0 sm:border-r" : "sm:col-span-2"}`}>
              <div className="flex items-start justify-between">
                <span className="font-mono text-[10px] uppercase tracking-[.18em] text-[#65685f]">[{code}]</span>
                <Icon className="h-5 w-5 transition-transform group-hover:-translate-y-1 group-hover:translate-x-1" strokeWidth={1.5} />
              </div>
              <div className="font-display mt-12 text-5xl font-semibold tracking-[-.06em]">{value.toString().padStart(2, "0")}</div>
              <h2 className="mt-3 font-display text-base font-semibold">{label}</h2>
              <p className="mt-1 text-xs text-[#65685f]">{detail}</p>
            </div>
          ))}
        </section>

        <section className="grid gap-0 border-b border-[#151713] lg:grid-cols-[minmax(0,1.4fr)_minmax(300px,.6fr)]">
          <div className="py-10 lg:border-r lg:border-[#151713] lg:pr-10">
            <div className="mb-6 flex items-end justify-between">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[.18em] text-[#65685f]">[03 / Work stack]</p>
                <h2 className="font-display mt-2 text-3xl font-semibold tracking-[-.04em]">Priority bids</h2>
              </div>
              <span className="font-mono text-[10px] uppercase text-[#65685f]">{priorityProjects.length} records</span>
            </div>
            <div className="border-t border-[#151713]">
              {priorityProjects.length === 0 ? (
                <div className="flex min-h-40 items-center justify-between border-b border-[#151713] py-8">
                  <div><p className="font-display text-xl font-semibold">The work stack is clear.</p><p className="mt-1 text-sm text-[#65685f]">Start a project to create the first estimating record.</p></div>
                  <FolderOpen className="h-8 w-8" strokeWidth={1.2} />
                </div>
              ) : priorityProjects.map((project, index) => {
                const financials = calculateProjectFinancials(project.estimateItems, project.overheadPercentage, project.markupPercentage);
                return (
                  <button key={project.id} onClick={() => onOpenProject(project)} className="group grid w-full grid-cols-[42px_minmax(0,1fr)_auto_28px] items-center gap-3 border-b border-[#b9b8b0] py-5 text-left transition-all hover:bg-[#151713] hover:px-3 hover:text-[#f1efe8]">
                    <span className="font-mono text-[10px] text-[#7b7e75]">{String(index + 1).padStart(2, "0")}</span>
                    <span className="min-w-0"><span className="font-display block truncate text-base font-semibold">{project.name}</span><span className="mt-1 block truncate text-xs opacity-60">{project.address || "Address not set"}</span></span>
                    <span className="text-right"><span className="font-mono block text-sm font-semibold">{financials.finalPrice > 0 ? formatRoundedCurrency(financials.finalPrice) : "—"}</span><span className="font-mono text-[9px] uppercase opacity-60">{project.status}</span></span>
                    <ArrowUpRight className="h-4 w-4 transition-transform group-hover:-translate-y-1 group-hover:translate-x-1" />
                  </button>
                );
              })}
            </div>
          </div>

          <aside className="bg-[#151713] px-6 py-10 text-[#f1efe8] rb-noise lg:px-8">
            <p className="font-mono text-[10px] uppercase tracking-[.18em] text-[#d9ff43]">Sequence / 05 stages</p>
            <h2 className="font-display mt-3 text-3xl font-semibold tracking-[-.04em]">From sheet<br />to signature.</h2>
            <ol className="mt-10 border-t border-white/20">
              {["Plan set", "Quantity takeoff", "Cost build", "Estimator review", "Client issue"].map((step, index) => (
                <li key={step} className="flex items-center gap-4 border-b border-white/20 py-4">
                  <span className={`font-mono text-[10px] ${index === 0 ? "text-[#d9ff43]" : "text-white/40"}`}>0{index + 1}</span>
                  <span className="font-display text-sm font-medium">{step}</span>
                  {index === 0 && <span className="ml-auto h-2 w-2 bg-[#d9ff43]" />}
                </li>
              ))}
            </ol>
            <p className="mt-8 text-xs leading-5 text-white/50">Every stage preserves the evidence behind the number. No black-box totals.</p>
          </aside>
        </section>
      </div>
    </div>
  );
};
