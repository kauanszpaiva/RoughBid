import React, { useState } from "react";
import {
  Clock,
  Copy,
  ExternalLink,
  Filter,
  FolderOpen,
  MapPin,
  MoreVertical,
  Plus,
  Trash2,
} from "lucide-react";
import { Project, ProjectStatus } from "../types";
import { calculateProjectFinancials, formatRoundedCurrency } from "../utils/calculations";

interface ProjectsPageProps {
  canWrite?: boolean;
  projects: Project[];
  onOpenProject: (project: Project) => void;
  onNewProject: () => void;
  onDeleteProject: (projectId: string) => void;
  onDuplicateProject: (project: Project) => void;
}

const getStatusBadge = (status: ProjectStatus) => {
  switch (status) {
    case "In Progress":
      return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-[#eff6ff] text-[#2563eb] uppercase tracking-wider">IN PROGRESS</span>;
    case "Planning":
      return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-[#f3f4f6] text-[#4b5563] uppercase tracking-wider">PLANNING</span>;
    case "Completed":
      return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700 uppercase tracking-wider">COMPLETED</span>;
    default:
      return null;
  }
};

export const ProjectsPage: React.FC<ProjectsPageProps> = ({
  canWrite = false,
  projects,
  onOpenProject,
  onNewProject,
  onDeleteProject,
  onDuplicateProject,
}) => {
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);

  const filteredProjects = projects.filter((p) => filterStatus === "all" || p.status.toLowerCase() === filterStatus.toLowerCase());
  const withPlansCount = projects.filter((p) => p.revisions.length > 0).length;
  const unsentCount = projects.filter((p) => p.estimateItems.length > 0 && p.status !== "Completed").length;

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-7xl mx-auto space-y-6 select-none font-sans">
      <section className="bg-white border border-[#e5e7eb] rounded-lg p-5 shadow-xs">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-[#2563eb]">Project Workspace</p>
            <h2 className="text-xl sm:text-2xl font-extrabold text-[#111827] tracking-tight mt-1">Projects</h2>
            <p className="text-xs text-[#6b7280] mt-1 max-w-2xl">
              Every job stays separate: plans, quantities, estimate, client proposal, organization access, and audit trail.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center gap-2 self-stretch lg:self-auto">
            <div className="relative flex-1 lg:flex-none">
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="w-full lg:w-auto appearance-none bg-white border border-[#e5e7eb] rounded-md px-3 py-2 pr-8 text-xs font-medium text-[#374151] hover:bg-[#f9fafb] transition focus:outline-hidden cursor-pointer shadow-xs"
              >
                <option value="all">All Projects</option>
                <option value="in progress">In Progress</option>
                <option value="planning">Planning</option>
                <option value="completed">Completed</option>
              </select>
              <Filter className="w-3.5 h-3.5 text-[#9ca3af] absolute right-2.5 top-2.5 pointer-events-none" />
            </div>

            <button
              onClick={onNewProject} disabled={!canWrite}
              className="flex items-center justify-center gap-1.5 px-4 py-2 bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-md text-xs font-semibold transition shadow-xs cursor-pointer whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Project</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-5">
          <div className="rounded-md bg-[#f9fafb] border border-[#e5e7eb] p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-[#6b7280]">Total</p>
            <p className="text-xl font-bold text-[#111827]">{projects.length}</p>
          </div>
          <div className="rounded-md bg-[#f9fafb] border border-[#e5e7eb] p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-[#6b7280]">With Plans</p>
            <p className="text-xl font-bold text-[#111827]">{withPlansCount}</p>
          </div>
          <div className="rounded-md bg-[#f9fafb] border border-[#e5e7eb] p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-[#6b7280]">Unsent Bids</p>
            <p className="text-xl font-bold text-[#111827]">{unsentCount}</p>
          </div>
          <div className="rounded-md bg-[#f9fafb] border border-[#e5e7eb] p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-[#6b7280]">Client Views</p>
            <p className="text-xl font-bold text-[#111827]">Public link</p>
          </div>
        </div>
      </section>

      {filteredProjects.length === 0 ? (
        <div className="bg-white border border-dashed border-[#e5e7eb] rounded-xl p-8 sm:p-12 text-center">
          <FolderOpen className="w-10 h-10 text-[#9ca3af] mx-auto mb-3" />
          <h3 className="text-sm font-bold text-[#111827]">No projects found</h3>
          <p className="text-xs text-[#6b7280] mt-1 mb-4">Create your first construction project to start building takeoffs and estimates.</p>
          <button onClick={onNewProject} disabled={!canWrite} className="px-4 py-2 bg-[#2563eb] text-white text-xs font-semibold rounded-md shadow-xs">
            Create New Project
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 md:gap-5">
          {filteredProjects.map((project) => {
            const financials = calculateProjectFinancials(project.estimateItems, project.overheadPercentage, project.markupPercentage);
            const hasEstimate = project.estimateItems.length > 0 && financials.finalPrice > 0;
            const isMenuOpen = activeMenuId === project.id;

            return (
              <div
                key={project.id}
                onClick={() => onOpenProject(project)}
                className="bg-white border border-[#e5e7eb] rounded-lg p-5 hover:border-[#2563eb] hover:shadow-md transition cursor-pointer relative group flex flex-col justify-between min-h-[195px]"
              >
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
                          disabled={!canWrite} onClick={() => {
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
                          disabled={!canWrite} onClick={() => {
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

                <div className="my-3">
                  <h3 className="text-sm font-bold text-[#111827] group-hover:text-[#2563eb] transition tracking-tight">{project.name}</h3>
                  <div className="flex items-center gap-1.5 text-xs text-[#6b7280] mt-1">
                    <MapPin className="w-3.5 h-3.5 text-[#9ca3af] shrink-0" />
                    <span className="truncate">{project.address}</span>
                  </div>
                </div>

                <div className="grid grid-cols-1 min-[420px]:grid-cols-3 gap-2 mb-3">
                  <div className="rounded-md bg-[#f9fafb] border border-[#e5e7eb] p-2">
                    <p className="text-[10px] text-[#6b7280] font-bold">Plans</p>
                    <p className="text-sm font-bold text-[#111827]">{project.revisions.length}</p>
                  </div>
                  <div className="rounded-md bg-[#f9fafb] border border-[#e5e7eb] p-2">
                    <p className="text-[10px] text-[#6b7280] font-bold">Items</p>
                    <p className="text-sm font-bold text-[#111827]">{project.estimateItems.length}</p>
                  </div>
                  <div className="rounded-md bg-[#f9fafb] border border-[#e5e7eb] p-2">
                    <p className="text-[10px] text-[#6b7280] font-bold">Margin</p>
                    <p className="text-sm font-bold text-[#111827]">{financials.marginPercentage.toFixed(0)}%</p>
                  </div>
                </div>

                <div className="pt-3 border-t border-[#e5e7eb] flex items-baseline justify-between text-xs">
                  <div>
                    <span className="text-[11px] text-[#6b7280] block font-medium">Estimate</span>
                    <span className="text-sm font-bold text-[#111827] font-mono">
                      {hasEstimate ? formatRoundedCurrency(financials.finalPrice) : "-"}
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
    </div>
  );
};
