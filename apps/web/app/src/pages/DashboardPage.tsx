import React, { useState } from "react";
import {
  Plus,
  Filter,
  MoreVertical,
  MapPin,
  Clock,
  FolderOpen,
  Trash2,
  Copy,
  ExternalLink,
  FileSearch,
  Send,
  DollarSign,
  AlertTriangle,
  Sparkles,
  Camera,
  Video,
  Mic,
} from "lucide-react";
import { Project, ProjectStatus } from "../types";
import { calculateProjectFinancials, formatRoundedCurrency } from "../utils/calculations";

interface DashboardPageProps {
  projects: Project[];
  onOpenProject: (project: Project) => void;
  onNewProject: () => void;
  onDeleteProject: (projectId: string) => void;
  onDuplicateProject: (project: Project) => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({
  projects,
  onOpenProject,
  onNewProject,
  onDeleteProject,
  onDuplicateProject,
}) => {
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);

  const filteredProjects = projects.filter((p) => {
    if (filterStatus === "all") return true;
    return p.status.toLowerCase() === filterStatus.toLowerCase();
  });

  // Calculate recent activity metrics
  const activeBidsCount = projects.filter((p) => p.status === "In Progress").length;
  const readyToSendCount = projects.filter((p) => p.estimateItems.length > 0 && p.revisions.length > 0).length;
  const plansInAiQueue = projects.reduce((sum, p) => sum + p.revisions.filter((r) => r.processingStatus === "queued" || r.processingStatus === "processing" || r.aiPlanStatus === "queued" || r.aiPlanStatus === "processing").length, 0);
  const missingEstimateCount = projects.filter((p) => p.revisions.length > 0 && p.estimateItems.length === 0).length;
  const totalPipeline = projects.reduce((sum, p) => {
    const fin = calculateProjectFinancials(p.estimateItems, p.overheadPercentage, p.markupPercentage);
    return sum + fin.finalPrice;
  }, 0);

  const formatPipelineShort = (amount: number) => {
    if (amount >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`;
    if (amount >= 1000) return `$${Math.round(amount / 1000)}k`;
    return `$${Math.round(amount)}`;
  };

  const averageMargin = projects.length
    ? projects.reduce((sum, p) => {
        const fin = calculateProjectFinancials(p.estimateItems, p.overheadPercentage, p.markupPercentage);
        return sum + fin.marginPercentage;
      }, 0) / projects.length
    : 0;

  const upcomingActions = [
    { label: "Review uploaded plans", value: missingEstimateCount, icon: <FileSearch className="w-4 h-4" />, tone: "text-blue-700 bg-blue-50" },
    { label: "Client-ready estimates", value: readyToSendCount, icon: <Send className="w-4 h-4" />, tone: "text-emerald-700 bg-emerald-50" },
    { label: "AI processing jobs", value: plansInAiQueue, icon: <Sparkles className="w-4 h-4" />, tone: "text-indigo-700 bg-indigo-50" },
  ];

  const getStatusBadge = (status: ProjectStatus) => {
    switch (status) {
      case "In Progress":
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-[#eff6ff] text-[#2563eb] uppercase tracking-wider">
            IN PROGRESS
          </span>
        );
      case "Planning":
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-[#f3f4f6] text-[#4b5563] uppercase tracking-wider">
            PLANNING
          </span>
        );
      case "Completed":
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700 uppercase tracking-wider">
            COMPLETED
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-7xl mx-auto space-y-6 md:space-y-8 select-none font-sans">
      {/* Title & Top Action Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3.5">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-[#111827] tracking-tight">
            Your Projects
          </h2>
          <p className="text-xs text-[#6b7280] mt-0.5 max-w-2xl">
            Track active bids, plan reading, pricing coverage, and client-ready estimates from one workspace.
          </p>
        </div>

        <div className="flex items-center gap-2 sm:gap-2.5 self-stretch sm:self-auto justify-between sm:justify-end">
          {/* Filter Dropdown */}
          <div className="relative flex-1 sm:flex-none">
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="w-full sm:w-auto appearance-none bg-white border border-[#e5e7eb] rounded-md px-3 py-1.5 pr-8 text-xs font-medium text-[#374151] hover:bg-[#f9fafb] transition focus:outline-hidden cursor-pointer shadow-xs"
            >
              <option value="all">All Projects</option>
              <option value="in progress">In Progress</option>
              <option value="planning">Planning</option>
              <option value="completed">Completed</option>
            </select>
            <Filter className="w-3.5 h-3.5 text-[#9ca3af] absolute right-2.5 top-2.5 pointer-events-none" />
          </div>

          {/* New Project Button */}
          <button
            onClick={onNewProject}
            className="flex items-center justify-center gap-1.5 px-3.5 sm:px-4 py-1.5 bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-md text-xs font-semibold transition shadow-xs cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Project</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <div className="bg-white border border-[#e5e7eb] rounded-lg p-4 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider">Pipeline</span>
            <DollarSign className="w-4 h-4 text-[#2563eb]" />
          </div>
          <div className="text-2xl font-bold text-[#111827] mt-1 font-mono">{formatPipelineShort(totalPipeline)}</div>
          <p className="text-[11px] text-[#6b7280] mt-1">Gross proposal value across local projects.</p>
        </div>
        <div className="bg-white border border-[#e5e7eb] rounded-lg p-4 shadow-xs">
          <span className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider">Avg Margin</span>
          <div className="text-2xl font-bold text-[#111827] mt-1 font-mono">{averageMargin.toFixed(1)}%</div>
          <p className="text-[11px] text-[#6b7280] mt-1">Target stays at 50%+ gross margin for RoughBid pricing.</p>
        </div>
        <div className="bg-white border border-[#e5e7eb] rounded-lg p-4 shadow-xs">
          <span className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider">AI Queue</span>
          <div className="text-2xl font-bold text-[#111827] mt-1">{plansInAiQueue}</div>
          <p className="text-[11px] text-[#6b7280] mt-1">Plan reading jobs waiting or processing.</p>
        </div>
        <div className="bg-white border border-[#e5e7eb] rounded-lg p-4 shadow-xs">
          <span className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider">Ready To Send</span>
          <div className="text-2xl font-bold text-[#111827] mt-1">{readyToSendCount}</div>
          <p className="text-[11px] text-[#6b7280] mt-1">Projects with plans and estimate lines.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_0.8fr] gap-4">
        <div className="bg-white border border-[#e5e7eb] rounded-lg p-5 shadow-xs">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-bold text-[#111827]">Next Work</h3>
              <p className="text-xs text-[#6b7280] mt-0.5">Operational actions a nontechnical estimator can follow.</p>
            </div>
            <AlertTriangle className="w-4 h-4 text-amber-500" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {upcomingActions.map((action) => (
              <div key={action.label} className="border border-[#e5e7eb] rounded-lg p-3">
                <div className={`w-8 h-8 rounded-md flex items-center justify-center ${action.tone}`}>{action.icon}</div>
                <div className="text-xl font-bold text-[#111827] mt-2">{action.value}</div>
                <div className="text-xs text-[#6b7280]">{action.label}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="bg-white border border-[#e5e7eb] rounded-lg p-5 shadow-xs">
          <h3 className="text-sm font-bold text-[#111827]">Marketplace Status</h3>
          <p className="text-xs text-[#6b7280] mt-1">
            New England price books, public bid indexes, and licensed cost feeds will be separate paid add-ons.
          </p>
          <div className="mt-4 space-y-2 text-xs">
            <div className="flex items-center justify-between border border-[#e5e7eb] rounded-md px-3 py-2">
              <span>Free trial AI budget</span>
              <strong className="text-[#111827]">max $0.80/user</strong>
            </div>
            <div className="flex items-center justify-between border border-[#e5e7eb] rounded-md px-3 py-2">
              <span>Default project COGS cap</span>
              <strong className="text-[#111827]">max $0.75/project</strong>
            </div>
            <div className="flex items-center justify-between border border-[#e5e7eb] rounded-md px-3 py-2">
              <span>Margin guardrail</span>
              <strong className="text-[#111827]">50%+</strong>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white border border-[#e5e7eb] rounded-lg p-5 shadow-xs">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[#2563eb]" />
              <h3 className="text-sm font-bold text-[#111827]">Remodel Intake</h3>
              <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 bg-amber-50 border border-amber-100 rounded px-1.5 py-0.5">
                Soon
              </span>
            </div>
            <p className="text-xs text-[#6b7280] mt-1 max-w-2xl">
              Future budget intake for remodels: upload a site photo, short walkthrough video, or voice note and RoughBid will turn it into a reviewable scope draft.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 shrink-0">
            {[
              { label: "Photo", icon: <Camera className="w-4 h-4" /> },
              { label: "Video", icon: <Video className="w-4 h-4" /> },
              { label: "Audio", icon: <Mic className="w-4 h-4" /> },
            ].map((item) => (
              <div key={item.label} className="min-w-[78px] border border-[#e5e7eb] rounded-md px-3 py-2 text-center text-[#6b7280] bg-[#f9fafb]">
                <div className="flex justify-center text-[#2563eb]">{item.icon}</div>
                <div className="text-[11px] font-semibold mt-1">{item.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Projects Grid */}
      {filteredProjects.length === 0 ? (
        <div className="bg-white border border-dashed border-[#e5e7eb] rounded-xl p-8 sm:p-12 text-center">
          <FolderOpen className="w-10 h-10 text-[#9ca3af] mx-auto mb-3" />
          <h3 className="text-sm font-bold text-[#111827]">No projects found</h3>
          <p className="text-xs text-[#6b7280] mt-1 mb-4">
            Create your first construction project to start building takeoffs and estimates.
          </p>
          <button
            onClick={onNewProject}
            className="px-4 py-2 bg-[#2563eb] text-white text-xs font-semibold rounded-md shadow-xs"
          >
            + Create New Project
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
          {filteredProjects.map((project) => {
            const financials = calculateProjectFinancials(
              project.estimateItems,
              project.overheadPercentage,
              project.markupPercentage
            );
            const hasEstimate = project.estimateItems.length > 0 && financials.finalPrice > 0;
            const isMenuOpen = activeMenuId === project.id;

            return (
              <div
                key={project.id}
                onClick={() => onOpenProject(project)}
                className="bg-white border border-[#e5e7eb] rounded-xl p-5 hover:border-[#2563eb] hover:shadow-md transition cursor-pointer relative group flex flex-col justify-between min-h-[170px]"
              >
                {/* Card Top: Status & Menu */}
                <div className="flex items-start justify-between">
                  <div>{getStatusBadge(project.status)}</div>

                  <div className="relative" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => setActiveMenuId(isMenuOpen ? null : project.id)}
                      className="p-1 text-[#9ca3af] hover:text-[#111827] rounded-md transition"
                      title="Project Options"
                    >
                      <MoreVertical className="w-4 h-4" />
                    </button>

                    {isMenuOpen && (
                      <div className="absolute right-0 top-6 w-36 bg-white border border-[#e5e7eb] rounded-lg shadow-lg py-1 z-20 text-xs text-[#374151]">
                        <button
                          onClick={() => {
                            setActiveMenuId(null);
                            onOpenProject(project);
                          }}
                          className="w-full text-left px-3 py-1.5 hover:bg-[#f3f4f6] flex items-center gap-2"
                        >
                          <ExternalLink className="w-3.5 h-3.5 text-[#6b7280]" />
                          <span>Open Project</span>
                        </button>
                        <button
                          onClick={() => {
                            setActiveMenuId(null);
                            onDuplicateProject(project);
                          }}
                          className="w-full text-left px-3 py-1.5 hover:bg-[#f3f4f6] flex items-center gap-2"
                        >
                          <Copy className="w-3.5 h-3.5 text-[#6b7280]" />
                          <span>Duplicate</span>
                        </button>
                        <div className="my-1 border-t border-[#e5e7eb]" />
                        <button
                          onClick={() => {
                            setActiveMenuId(null);
                            onDeleteProject(project.id);
                          }}
                          className="w-full text-left px-3 py-1.5 text-rose-600 hover:bg-rose-50 flex items-center gap-2 font-medium"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Delete</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Card Body: Title & Address */}
                <div className="my-2.5">
                  <h3 className="text-sm font-bold text-[#111827] group-hover:text-[#2563eb] transition tracking-tight">
                    {project.name}
                  </h3>
                  <div className="flex items-center gap-1.5 text-xs text-[#6b7280] mt-1">
                    <MapPin className="w-3.5 h-3.5 text-[#9ca3af] shrink-0" />
                    <span className="truncate">{project.address}</span>
                  </div>
                </div>

                {/* Card Footer: Est. Total & Updated */}
                <div className="pt-3 border-t border-[#e5e7eb] flex items-baseline justify-between text-xs">
                  <div>
                    <span className="text-[11px] text-[#6b7280] block font-medium">Est. Total</span>
                    <span className="text-sm font-bold text-[#111827] font-mono">
                      {hasEstimate ? formatRoundedCurrency(financials.finalPrice) : "—"}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 text-[11px] text-[#6b7280]">
                    <Clock className="w-3 h-3 text-[#9ca3af]" />
                    <span>{project.updatedAt}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Recent Activity Summary Section */}
      <div className="pt-4 border-t border-[#e5e7eb]">
        <h3 className="text-xs font-bold text-[#6b7280] uppercase tracking-wider mb-3">
          Recent Activity Summary
        </h3>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-white border border-[#e5e7eb] rounded-lg p-4 shadow-xs">
            <span className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider block">
              ACTIVE BIDS
            </span>
            <div className="text-2xl font-bold text-[#111827] mt-0.5">
              {activeBidsCount}
            </div>
          </div>

          <div className="bg-white border border-[#e5e7eb] rounded-lg p-4 shadow-xs">
            <span className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider block">
              TOTAL PIPELINE
            </span>
            <div className="text-2xl font-bold text-[#111827] mt-0.5 font-mono">
              {formatPipelineShort(totalPipeline)}
            </div>
          </div>

          <div className="bg-white border border-[#e5e7eb] rounded-lg p-4 shadow-xs">
            <span className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider block">
              COMPLETED PROJECTS
            </span>
            <div className="text-2xl font-bold text-[#111827] mt-0.5">
              {projects.filter((p) => p.status === "Completed").length}
            </div>
          </div>

          <div className="bg-white border border-[#e5e7eb] rounded-lg p-4 shadow-xs">
            <span className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider block">
              PLAN REVISIONS
            </span>
            <div className="text-2xl font-bold text-[#111827] mt-0.5">
              {projects.reduce((sum, p) => sum + p.revisions.length, 0)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
