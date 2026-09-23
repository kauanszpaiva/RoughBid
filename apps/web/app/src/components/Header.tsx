import React from "react";
import { FileDown, Plus, ChevronLeft, Menu, LogIn } from "lucide-react";
import { Project, UserProfile } from "../types";
import { ownerProfileImage } from "../utils/branding";
import { projectReadiness } from "../utils/projectReadiness";

export type ProjectStep = "plans" | "quantities" | "estimate" | "review" | "export";

interface HeaderProps {
  canWrite?: boolean;
  project: Project | null;
  activeStep: ProjectStep;
  onSelectStep: (step: ProjectStep) => void;
  onBackToProjects: () => void;
  onExportPDF: () => void;
  onCreateEstimate: () => void;
  onOpenNewProject: () => void;
  onToggleMobileMenu?: () => void;
  user?: UserProfile;
  onOpenAuth?: () => void;
  isSignedIn?: boolean;
  pageTitle?: string;
}

type RailState = "complete" | "attention" | "pending" | "locked";

export const Header: React.FC<HeaderProps> = ({
  canWrite = false,
  project,
  activeStep,
  onSelectStep,
  onBackToProjects,
  onExportPDF,
  onCreateEstimate,
  onOpenNewProject,
  onToggleMobileMenu,
  user,
  onOpenAuth,
  isSignedIn = false,
  pageTitle = "Projects",
}) => {
  const readiness = project ? projectReadiness(project) : null;
  const currentPlan = project?.revisions.find((revision) => revision.isCurrent) ?? project?.revisions.at(-1);
  const aiStatus = currentPlan?.aiPlanStatus;
  const missingPriceCount = project?.estimateItems.filter((item) => item.pricingStatus === "missing_price").length ?? 0;

  const planRail = (): { state: RailState; detail: string } => {
    if (!project || !readiness) return { state: "pending", detail: "NO PLAN" };
    if (aiStatus === "failed") return { state: "attention", detail: "AI FAILED" };
    if (aiStatus === "queued" || aiStatus === "processing") return { state: "attention", detail: "RB.AI READING" };
    if (aiStatus === "needs_review" || aiStatus === "ready") return { state: "attention", detail: "AI REVIEW" };
    if (readiness.hasPlan) return { state: "complete", detail: currentPlan?.pages ? `${currentPlan.pages} SHEETS` : "PLAN READY" };
    return { state: "pending", detail: "NO PLAN" };
  };

  const stages: Array<{ id: ProjectStep; code: string; label: string; state: RailState; detail: string }> = project && readiness
    ? [
        { id: "plans", code: "01", label: "PLAN", ...planRail() },
        {
          id: "quantities",
          code: "02",
          label: "TAKEOFF",
          state: readiness.hasQuantities ? "complete" : project.quantities.length ? "attention" : "pending",
          detail: project.quantities.length ? `${project.quantities.length} ITEMS` : "EMPTY",
        },
        {
          id: "estimate",
          code: "03",
          label: "COST",
          state: readiness.hasEstimate ? "complete" : project.estimateItems.length ? "attention" : "pending",
          detail: readiness.hasEstimate
            ? `${project.estimateItems.length} PRICED`
            : project.estimateItems.length
              ? `${missingPriceCount || project.estimateItems.length} TO PRICE`
              : "NO COST BUILD",
        },
        {
          id: "review",
          code: "04",
          label: "CHECK",
          state: readiness.canExport ? "complete" : "attention",
          detail: readiness.canExport ? "READY" : `${readiness.issues.length} BLOCKER${readiness.issues.length === 1 ? "" : "S"}`,
        },
        {
          id: "export",
          code: "05",
          label: "ISSUE",
          state: readiness.canExport ? "complete" : "locked",
          detail: readiness.canExport ? "UNLOCKED" : "LOCKED",
        },
      ]
    : [];

  const activeIndex = Math.max(0, stages.findIndex((stage) => stage.id === activeStep));
  const activeRail = stages[activeIndex];

  const userInitials = user?.name
    ? user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
    : "JS";
  const ownerAvatar = ownerProfileImage(user?.email);

  const stateDot = (state: RailState) => {
    if (state === "complete") return "bg-emerald-600";
    if (state === "attention") return "bg-[#d9ff43] ring-1 ring-[#151713]";
    if (state === "locked") return "bg-[#777a72]";
    return "bg-[#b4b2aa]";
  };

  return (
    <div className="flex flex-col shrink-0 z-20 select-none bg-[#f1efe8]">
      <header className="min-h-14 md:min-h-16 border-b border-[#151713] px-3 sm:px-4 md:px-6 xl:px-8 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 md:gap-3 min-w-0">
          <button
            onClick={onToggleMobileMenu}
            className="min-w-11 min-h-11 -ml-2 text-[#374151] hover:text-[#111827] hover:bg-[#e2e0d7] transition md:hidden cursor-pointer inline-flex items-center justify-center"
            aria-label="Open Navigation Menu"
          >
            <Menu className="w-5 h-5" />
          </button>

          {project ? (
            <div className="flex items-center gap-1.5 md:gap-2.5 min-w-0">
              <button
                onClick={onBackToProjects}
                className="min-w-10 min-h-10 text-[#6b7280] hover:text-[#111827] hover:bg-[#e2e0d7] transition cursor-pointer shrink-0 inline-flex items-center justify-center"
                title="Back to all projects"
                aria-label="Back to projects"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <h2 className="font-display text-sm md:text-lg font-semibold text-[#151713] tracking-tight truncate max-w-[135px] sm:max-w-[220px] xl:max-w-[320px]">
                    {project.name}
                  </h2>
                  <span className="hidden xl:inline-block font-mono text-[9px] uppercase tracking-[.12em] text-[#6b6e66] shrink-0">
                    RB-{project.id.toUpperCase().slice(0, 8)}
                  </span>
                </div>
                {activeRail && (
                  <p className="md:hidden mt-0.5 font-mono text-[9px] uppercase tracking-[.12em] text-[#6b6e66]">
                    {activeRail.code} / 05 · {activeRail.label} · {activeRail.detail}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <img src="/brand/roughbid-mark.png" alt="RoughBid" className="w-8 h-8 object-contain md:hidden" />
              <h2 className="font-display text-base md:text-lg font-semibold text-[#151713] tracking-tight">
                <span className="sr-only md:hidden">RoughBid</span>
                <span className="hidden md:inline">{pageTitle}</span>
              </h2>
            </div>
          )}
        </div>

        {project && (
          <nav aria-label="Bid workflow" className="hidden lg:grid grid-cols-5 border-x border-[#151713] self-stretch min-w-[500px] max-w-[760px] flex-1 mx-3">
            {stages.map((stage) => {
              const isActive = activeStep === stage.id;
              return (
                <button
                  key={stage.id}
                  onClick={() => onSelectStep(stage.id)}
                  className={`relative min-w-0 px-3 py-2 border-r border-[#151713] last:border-r-0 text-left transition-colors cursor-pointer focus-visible:z-10 ${
                    isActive
                      ? "bg-[#151713] text-[#f1efe8]"
                      : "bg-[#f1efe8] text-[#151713] hover:bg-[#e2e0d7]"
                  }`}
                  aria-current={isActive ? "step" : undefined}
                >
                  {isActive && <span className="absolute inset-x-0 bottom-0 h-1 bg-[#d9ff43]" />}
                  <div className="flex items-center justify-between gap-2">
                    <span className={`font-mono text-[9px] uppercase tracking-[.14em] ${isActive ? "text-[#d9ff43]" : "text-[#6b6e66]"}`}>
                      {stage.code} / {stage.label}
                    </span>
                    <span className={`w-2 h-2 shrink-0 ${stateDot(stage.state)}`} aria-hidden="true" />
                  </div>
                  <p className={`mt-1 truncate font-mono text-[9px] uppercase tracking-[.08em] ${isActive ? "text-white/65" : "text-[#777a72]"}`}>
                    {stage.detail}
                  </p>
                </button>
              );
            })}
          </nav>
        )}

        <div className="flex items-center gap-2 md:gap-3 shrink-0">
          {project ? (
            <>
              <button
                onClick={onExportPDF}
                className="hidden xl:flex min-h-10 border border-[#151713] text-[#151713] hover:bg-[#151713] hover:text-[#f1efe8] px-3 font-mono text-[10px] uppercase tracking-wide font-semibold items-center gap-1.5 transition cursor-pointer"
              >
                <FileDown className="w-3.5 h-3.5" />
                <span>Export</span>
              </button>

              <button
                onClick={onCreateEstimate}
                disabled={!canWrite}
                className="hidden lg:flex min-h-10 bg-[#d9ff43] border border-[#151713] text-[#151713] px-3.5 font-mono text-[10px] uppercase tracking-wide font-semibold hover:bg-[#151713] hover:text-[#d9ff43] items-center gap-1.5 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <span>Build estimate</span>
              </button>

              <button
                onClick={onExportPDF}
                className="sm:hidden min-w-11 min-h-11 text-[#374151] border border-[#151713] transition cursor-pointer inline-flex items-center justify-center"
                title="Export PDF"
                aria-label="Export PDF"
              >
                <FileDown className="w-4 h-4" />
              </button>
            </>
          ) : (
            <button
              onClick={onOpenNewProject}
              aria-label="New Project"
              disabled={!canWrite}
              className="flex min-h-10 items-center gap-1.5 border border-[#151713] px-3 md:px-3.5 bg-[#d9ff43] hover:bg-[#151713] hover:text-[#d9ff43] text-[#151713] font-mono text-[10px] uppercase tracking-wide font-semibold transition cursor-pointer disabled:opacity-40"
            >
              <Plus className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">New Project</span>
            </button>
          )}

          <button
            onClick={onOpenAuth}
            className={isSignedIn
              ? "w-10 h-10 rounded-full bg-[#d1d5db] hover:bg-[#9ca3af] text-[#374151] font-bold text-xs flex items-center justify-center transition cursor-pointer shrink-0"
              : "h-10 px-3 bg-[#151713] hover:bg-black text-white font-semibold text-xs flex items-center gap-1.5 transition cursor-pointer shrink-0"}
            title={isSignedIn ? user?.name || "Account Profile" : "Sign in or create account"}
          >
            {isSignedIn ? (ownerAvatar
              ? <img src={ownerAvatar} alt="RoughBid owner profile" className="w-full h-full rounded-full bg-white p-0.5 object-contain ring-1 ring-slate-200" />
              : userInitials) : (
              <>
                <LogIn className="w-3.5 h-3.5" />
                <span>Sign in</span>
              </>
            )}
          </button>
        </div>
      </header>

      {project && (
        <div className="lg:hidden bg-[#151713] border-b border-black px-3 py-2 overflow-x-auto no-scrollbar">
          <div className="flex items-stretch min-w-max">
            {stages.map((stage) => {
              const isActive = activeStep === stage.id;
              return (
                <button
                  key={stage.id}
                  onClick={() => onSelectStep(stage.id)}
                  className={`min-h-11 px-3.5 border-r border-white/15 first:border-l flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.08em] transition cursor-pointer ${
                    isActive ? "bg-[#d9ff43] text-[#151713]" : "text-white/55 hover:text-white hover:bg-white/[.06]"
                  }`}
                  aria-current={isActive ? "step" : undefined}
                >
                  <span>{stage.code}</span>
                  <span className="font-semibold">{stage.label}</span>
                  <span className={`w-1.5 h-1.5 ${isActive ? "bg-[#151713]" : stateDot(stage.state)}`} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
