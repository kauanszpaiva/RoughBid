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
      return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-brand-50 text-brand-500 uppercase tracking-wider">IN PROGRESS</span>;
    case "Planning":
      return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-600 uppercase tracking-wider">PLANNING</span>;
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
      <section className="bg-white border border-slate-200 rounded-lg p-5 shadow-xs">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-brand-500">Project Workspace</p>
            <h2 className="font-display text-2xl font-semibold text-slate-900 tracking-tight mt-1">Projects</h2>
            <p className="text-xs text-slate-500 mt-1 max-w-2xl">
              Every job stays separate: plans, quantities, estimate, client proposal, organization access, and audit trail.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center gap-2 self-stretch lg:self-auto">
            <div className="relative flex-1 lg:flex-none">
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="w-full lg:w-auto appearance-none bg-white border border-slate-200 rounded-md px-3 py-2 pr-8 text-xs font-medium text-slate-600 hover:bg-slate-50 transition focus:outline-hidden cursor-pointer shadow-xs"
              >
                <option value="all">All Projects</option>
                <option value="in progress">In Progress</option>
                <option value="planning">Planning</option>
                <option value="completed">Completed</option>
              </select>
              <Filter className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-2.5 pointer-events-none" />
            </div>

            <button
              onClick={onNewProject} disabled={!canWrite}
              className="flex items-center justify-center gap-1.5 px-4 py-2 bg-brand-500 hover:bg-brand-700 text-white rounded-md text-xs font-semibold transition shadow-xs cursor-pointer whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Project</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-5">
          <div className="rounded-md bg-slate-50 border border-slate-200 p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Total</p>
            <p className="text-xl font-bold text-slate-900">{projects.length}</p>
          </div>
          <div className="rounded-md bg-slate-50 border border-slate-200 p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">With Plans</p>
            <p className="text-xl font-bold text-slate-900">{withPlansCount}</p>
          </div>
          <div className="rounded-md bg-slate-50 border border-slate-200 p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Unsent Bids</p>
            <p className="text-xl font-bold text-slate-900">{unsentCount}</p>
          </div>
          <div className="rounded-md bg-slate-50 border border-slate-200 p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Client Views</p>
            <p className="text-xl font-bold text-slate-900">Public link</p>
          </div>
        </div>
      </section>

      {filteredProjects.length === 0 ? (
        <div className="bg-white border border-dashed border-slate-200 rounded-xl p-8 sm:p-12 text-center">
          <FolderOpen className="w-10 h-10 text-slate-400 mx-auto mb-3" />
          <h3 className="text-sm font-bold text-slate-900">No projects found</h3>
          <p className="text-xs text-slate-500 mt-1 mb-4">Create your first construction project to start building takeoffs and estimates.</p>
          <button onClick={onNewProject} disabled={!canWrite} className="px-4 py-2 bg-brand-500 text-white text-xs font-semibold rounded-md shadow-xs">
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
                className="bg-white border border-slate-200 rounded-lg p-5 hover:border-brand-500 hover:shadow-md transition cursor-pointer relative group flex flex-col justify-between min-h-[195px]"
              >
                <div className="flex items-start justify-between">
                  <div>{getStatusBadge(project.status)}</div>

                  <div className="relative" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => setActiveMenuId(isMenuOpen ? null : project.id)}
                      className="p-1 text-slate-400 hover:text-slate-900 rounded-md transition"
                      title="Project Options"
                    >
                      <MoreVertical className="w-4 h-4" />
                    </button>

                    {isMenuOpen && (
                      <div className="absolute right-0 top-6 w-36 bg-white border border-slate-200 rounded-lg shadow-lg py-1 z-20 text-xs text-slate-600">
                        <button
                          onClick={() => {
                            setActiveMenuId(null);
                            onOpenProject(project);
                          }}
                          className="w-full text-left px-3 py-1.5 hover:bg-slate-100 flex items-center gap-2"
                        >
                          <ExternalLink className="w-3.5 h-3.5 text-slate-500" />
                          <span>Open Project</span>
                        </button>
                        <button
                          disabled={!canWrite} onClick={() => {
                            setActiveMenuId(null);
                            onDuplicateProject(project);
                          }}
                          className="w-full text-left px-3 py-1.5 hover:bg-slate-100 flex items-center gap-2"
                        >
                          <Copy className="w-3.5 h-3.5 text-slate-500" />
                          <span>Duplicate</span>
                        </button>
                        <div className="my-1 border-t border-slate-200" />
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
                  <h3 className="text-sm font-bold text-slate-900 group-hover:text-brand-500 transition tracking-tight">{project.name}</h3>
                  <div className="flex items-center gap-1.5 text-xs text-slate-500 mt-1">
                    <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span className="truncate">{project.address}</span>
                  </div>
                </div>

                <div className="grid grid-cols-1 min-[420px]:grid-cols-3 gap-2 mb-3">
                  <div className="rounded-md bg-slate-50 border border-slate-200 p-2">
                    <p className="text-[10px] text-slate-500 font-bold">Plans</p>
                    <p className="text-sm font-bold text-slate-900">{project.revisions.length}</p>
                  </div>
                  <div className="rounded-md bg-slate-50 border border-slate-200 p-2">
                    <p className="text-[10px] text-slate-500 font-bold">Items</p>
                    <p className="text-sm font-bold text-slate-900">{project.estimateItems.length}</p>
                  </div>
                  <div className="rounded-md bg-slate-50 border border-slate-200 p-2">
                    <p className="text-[10px] text-slate-500 font-bold">Margin</p>
                    <p className="text-sm font-bold text-slate-900">{financials.marginPercentage.toFixed(0)}%</p>
                  </div>
                </div>

                <div className="pt-3 border-t border-slate-200 flex items-baseline justify-between text-xs">
                  <div>
                    <span className="text-[11px] text-slate-500 block font-medium">Estimate</span>
                    <span className="text-sm font-bold text-slate-900 font-mono">
                      {hasEstimate ? formatRoundedCurrency(financials.finalPrice) : "-"}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 text-[11px] text-slate-500">
                    <Clock className="w-3 h-3 text-slate-400" />
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
