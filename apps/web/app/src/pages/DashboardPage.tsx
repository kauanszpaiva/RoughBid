import React from "react";
import {
  AlertTriangle,
  ArrowRight,
  Camera,
  DollarSign,
  FileSearch,
  FolderOpen,
  Mic,
  Plus,
  Ruler,
  Send,
  Sparkles,
  Video,
} from "lucide-react";
import { Project } from "../types";
import { calculateProjectFinancials, formatRoundedCurrency } from "../utils/calculations";

interface DashboardPageProps {
  projects: Project[];
  onOpenProject: (project: Project) => void;
  onNewProject: () => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ projects, onOpenProject, onNewProject }) => {
  const activeBidsCount = projects.filter((p) => p.status === "In Progress").length;
  const completedCount = projects.filter((p) => p.status === "Completed").length;
  const readyToSendCount = projects.filter((p) => p.estimateItems.length > 0 && p.revisions.length > 0).length;
  const plansInAiQueue = projects.reduce(
    (sum, p) =>
      sum +
      p.revisions.filter(
        (r) =>
          r.processingStatus === "queued" ||
          r.processingStatus === "processing" ||
          r.aiPlanStatus === "queued" ||
          r.aiPlanStatus === "processing",
      ).length,
    0,
  );
  const missingEstimateCount = projects.filter((p) => p.revisions.length > 0 && p.estimateItems.length === 0).length;
  const totalPipeline = projects.reduce((sum, p) => {
    const fin = calculateProjectFinancials(p.estimateItems, p.overheadPercentage, p.markupPercentage);
    return sum + fin.finalPrice;
  }, 0);
  const averageMargin = projects.length
    ? projects.reduce((sum, p) => {
        const fin = calculateProjectFinancials(p.estimateItems, p.overheadPercentage, p.markupPercentage);
        return sum + fin.marginPercentage;
      }, 0) / projects.length
    : 0;

  const formatPipelineShort = (amount: number) => {
    if (amount >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`;
    if (amount >= 1000) return `$${Math.round(amount / 1000)}k`;
    return `$${Math.round(amount)}`;
  };

  const priorityProjects = projects.filter((project) => project.status !== "Completed").slice(0, 4);

  const commandCards = [
    {
      label: "Plans to read",
      value: missingEstimateCount,
      detail: "Uploaded drawings without estimate lines",
      icon: <FileSearch className="w-4 h-4" />,
      tone: "bg-blue-50 text-blue-700 border-blue-100",
    },
    {
      label: "Ready to send",
      value: readyToSendCount,
      detail: "Projects with plan + estimate data",
      icon: <Send className="w-4 h-4" />,
      tone: "bg-emerald-50 text-emerald-700 border-emerald-100",
    },
    {
      label: "AI queue",
      value: plansInAiQueue,
      detail: "Plan-reading jobs waiting or processing",
      icon: <Sparkles className="w-4 h-4" />,
      tone: "bg-indigo-50 text-indigo-700 border-indigo-100",
    },
  ];

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-7xl mx-auto space-y-6 md:space-y-8 select-none font-sans">
      <section className="grid grid-cols-1 xl:grid-cols-[1.25fr_0.75fr] gap-5">
        <div className="bg-white border border-[#e5e7eb] rounded-lg p-5 sm:p-6 shadow-xs">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-[#2563eb]">RoughBid Command Center</p>
              <h2 className="text-xl sm:text-2xl font-extrabold text-[#111827] tracking-tight mt-1">Dashboard</h2>
              <p className="text-xs text-[#6b7280] mt-1 max-w-2xl">
                One place to see what needs attention before a bid goes to the client.
              </p>
            </div>
            <button
              onClick={onNewProject}
              className="flex items-center justify-center gap-1.5 px-4 py-2 bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-md text-xs font-semibold transition shadow-xs cursor-pointer whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Project</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-6">
            <div className="border border-[#e5e7eb] rounded-lg p-4">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider">Pipeline</span>
                <DollarSign className="w-4 h-4 text-[#2563eb]" />
              </div>
              <div className="text-2xl font-bold text-[#111827] mt-1 font-mono">{formatPipelineShort(totalPipeline)}</div>
            </div>
            <div className="border border-[#e5e7eb] rounded-lg p-4">
              <span className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider">Avg Margin</span>
              <div className="text-2xl font-bold text-[#111827] mt-1 font-mono">{averageMargin.toFixed(1)}%</div>
            </div>
            <div className="border border-[#e5e7eb] rounded-lg p-4">
              <span className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider">Active Bids</span>
              <div className="text-2xl font-bold text-[#111827] mt-1">{activeBidsCount}</div>
            </div>
            <div className="border border-[#e5e7eb] rounded-lg p-4">
              <span className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider">Completed</span>
              <div className="text-2xl font-bold text-[#111827] mt-1">{completedCount}</div>
            </div>
          </div>
        </div>

        <div className="bg-[#111827] text-white rounded-lg p-5 sm:p-6 shadow-xs">
          <div className="flex items-center gap-2">
            <Ruler className="w-4 h-4 text-blue-300" />
            <h3 className="text-sm font-bold">Estimator Flow</h3>
          </div>
          <div className="mt-5 space-y-3">
            {["Plans", "Quantities", "Estimate", "Review", "Client View"].map((step, index) => (
              <div key={step} className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-md bg-white/10 border border-white/15 flex items-center justify-center text-[11px] font-bold">
                  {index + 1}
                </div>
                <span className="text-xs font-semibold text-slate-100">{step}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {commandCards.map((action) => (
          <div key={action.label} className="bg-white border border-[#e5e7eb] rounded-lg p-4 shadow-xs">
            <div className={`w-9 h-9 rounded-md border flex items-center justify-center ${action.tone}`}>{action.icon}</div>
            <div className="text-2xl font-bold text-[#111827] mt-3">{action.value}</div>
            <div className="text-sm font-bold text-[#111827]">{action.label}</div>
            <p className="text-xs text-[#6b7280] mt-1">{action.detail}</p>
          </div>
        ))}
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-[1fr_0.9fr] gap-5">
        <div className="bg-white border border-[#e5e7eb] rounded-lg p-5 shadow-xs">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <h3 className="text-sm font-bold text-[#111827]">Priority Projects</h3>
              <p className="text-xs text-[#6b7280] mt-0.5">The next bids that need plan review, pricing, or client delivery.</p>
            </div>
            <FolderOpen className="w-4 h-4 text-[#9ca3af]" />
          </div>

          {priorityProjects.length === 0 ? (
            <div className="border border-dashed border-[#d1d5db] rounded-lg p-6 text-center">
              <FolderOpen className="w-8 h-8 text-[#9ca3af] mx-auto mb-2" />
              <p className="text-sm font-bold text-[#111827]">No active projects</p>
              <button onClick={onNewProject} className="mt-3 text-xs font-bold text-[#2563eb]">
                Create the first project
              </button>
            </div>
          ) : (
            <div className="divide-y divide-[#e5e7eb]">
              {priorityProjects.map((project) => {
                const financials = calculateProjectFinancials(project.estimateItems, project.overheadPercentage, project.markupPercentage);
                return (
                  <button
                    key={project.id}
                    onClick={() => onOpenProject(project)}
                    className="w-full py-3 text-left flex items-center justify-between gap-4 hover:bg-[#f9fafb] px-2 rounded-md transition"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-[#111827] truncate">{project.name}</p>
                      <p className="text-xs text-[#6b7280] truncate">{project.address}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-bold text-[#111827] font-mono">
                        {financials.finalPrice > 0 ? formatRoundedCurrency(financials.finalPrice) : "-"}
                      </p>
                      <p className="text-[11px] text-[#6b7280]">{project.status}</p>
                    </div>
                    <ArrowRight className="w-4 h-4 text-[#9ca3af] shrink-0" />
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-white border border-[#e5e7eb] rounded-lg p-5 shadow-xs">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-[#2563eb]" />
                <h3 className="text-sm font-bold text-[#111827]">Remodel Intake</h3>
                <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 bg-amber-50 border border-amber-100 rounded px-1.5 py-0.5">
                  Soon
                </span>
              </div>
              <p className="text-xs text-[#6b7280] mt-1 max-w-xl">
                Future scope capture for photos, videos, and voice notes before they become estimate lines.
              </p>
            </div>
            <AlertTriangle className="w-4 h-4 text-amber-500" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-5">
            {[
              { label: "Photo", icon: <Camera className="w-4 h-4" /> },
              { label: "Video", icon: <Video className="w-4 h-4" /> },
              { label: "Audio", icon: <Mic className="w-4 h-4" /> },
            ].map((item) => (
              <div key={item.label} className="border border-[#e5e7eb] rounded-md px-3 py-3 text-center text-[#6b7280] bg-[#f9fafb]">
                <div className="flex justify-center text-[#2563eb]">{item.icon}</div>
                <div className="text-[11px] font-semibold mt-1">{item.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
};
