import React from "react";
import { FileDown, Plus, ChevronLeft, Menu, LogIn } from "lucide-react";
import { Project, UserProfile } from "../types";
import { ownerProfileImage } from "../utils/branding";

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
  /** Tabs that already own a primary create action hide the header duplicate. */
  showNewProjectAction?: boolean;
}

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
  showNewProjectAction = true,
}) => {
  const steps: { id: ProjectStep; label: string }[] = [
    { id: "plans", label: "Plans" },
    { id: "quantities", label: "Quantities" },
    { id: "estimate", label: "Estimate" },
    { id: "review", label: "Review" },
    { id: "export", label: "Export" },
  ];

  const userInitials = user?.name
    ? user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
    : "JS";
  const ownerAvatar = ownerProfileImage(user?.email);

  return (
    <div className="flex flex-col shrink-0 z-20 select-none bg-white">
      {/* Primary Header Bar */}
      <header className="h-14 md:h-16 border-b border-slate-200 px-3 sm:px-4 md:px-6 xl:px-8 flex items-center justify-between">
        {/* Left: Mobile Hamburger & Project / App Title */}
        <div className="flex items-center gap-2.5 md:gap-3 min-w-0">
          {/* Mobile hamburger menu toggle */}
          <button
            onClick={onToggleMobileMenu}
            className="p-1.5 -ml-1 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md transition md:hidden cursor-pointer"
            aria-label="Open Navigation Menu"
          >
            <Menu className="w-5 h-5" />
          </button>

          {project ? (
            <div className="flex items-center gap-1.5 md:gap-2.5 min-w-0">
              <button
                onClick={onBackToProjects}
                className="p-1 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md transition cursor-pointer shrink-0"
                title="Back to all projects"
                aria-label="Back to projects"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <div className="flex items-center gap-2 min-w-0">
                <h2 className="text-sm md:text-lg font-bold text-slate-900 tracking-tight truncate max-w-[140px] sm:max-w-[220px] md:max-w-none">
                  {project.name}
                </h2>
                {/* Shown only where the header has room next to the stepper and actions;
                    below lg it was being clipped to an unreadable "PRO.". */}
                <span className="hidden lg:inline-block shrink-0 px-2 py-0.5 bg-slate-100 text-slate-600 text-[10px] font-semibold rounded uppercase tracking-wide">
                  {project.id.toUpperCase().slice(0, 8)}
                </span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <img
                src="/brand/roughbid-mark.png"
                alt="RoughBid"
                className="w-8 h-8 object-contain rounded bg-white md:hidden"
              />
              <h2 className="font-display text-base md:text-lg font-semibold text-slate-900 tracking-tight">
                <span className="sr-only md:hidden">RoughBid</span>
                <span className="hidden md:inline">{pageTitle}</span>
              </h2>
            </div>
          )}
        </div>

        {/* Center (Desktop only): Pill Stepper navigation if project is active */}
        {project && (
          <div className="hidden md:flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-100 p-1">
            {steps.map((step) => {
              const isActive = activeStep === step.id;
              return (
                <button
                  key={step.id}
                  onClick={() => onSelectStep(step.id)}
                  aria-current={isActive ? "step" : undefined}
                  className={`rounded-md px-3.5 py-1.5 text-xs font-semibold transition cursor-pointer ${
                    isActive
                      ? "bg-white text-brand-700 shadow-sm"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  {step.label}
                </button>
              );
            })}
          </div>
        )}

        {/* Right: Actions & User Avatar */}
        <div className="flex items-center gap-2 md:gap-3 shrink-0">
          {project ? (
            <>
              {/* Desktop quick export & estimate buttons */}
              <button
                onClick={onExportPDF}
                className="hidden sm:flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 cursor-pointer"
              >
                <FileDown className="w-3.5 h-3.5 text-slate-500" />
                <span>Export PDF</span>
              </button>

              <button
                onClick={onCreateEstimate}
                disabled={!canWrite}
                className="hidden md:flex items-center gap-1.5 rounded-lg bg-brand-500 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
              >
                <span>Create Estimate</span>
              </button>

              {/* Mobile quick export icon button */}
              <button
                onClick={onExportPDF}
                className="sm:hidden rounded-lg border border-slate-200 bg-white p-2 text-slate-700 transition hover:bg-slate-50 cursor-pointer"
                title="Export PDF"
              >
                <FileDown className="w-4 h-4 text-slate-600" />
              </button>
            </>
          ) : (
            showNewProjectAction && (
              <button
                onClick={onOpenNewProject}
                aria-label="New Project"
                disabled={!canWrite}
                className="flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">New Project</span>
              </button>
            )
          )}

          <button
            onClick={onOpenAuth}
            className={isSignedIn
              ? "w-8 h-8 rounded-full border border-slate-200 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs flex items-center justify-center transition cursor-pointer shrink-0"
              : "h-8 px-3 rounded-lg bg-brand-500 hover:bg-brand-700 text-white font-semibold text-xs flex items-center gap-1.5 transition cursor-pointer shrink-0"}
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

      {/* Mobile Project Horizontal Stepper Bar */}
      {project && (
        <div className="md:hidden bg-white border-b border-slate-200 px-3 py-2 overflow-x-auto no-scrollbar">
          <div className="flex items-center gap-1.5 min-w-max">
            {steps.map((step, idx) => {
              const isActive = activeStep === step.id;
              const stepIdx = steps.findIndex((s) => s.id === step.id);
              const currentIdx = steps.findIndex((s) => s.id === activeStep);
              const isPast = stepIdx < currentIdx;

              return (
                <button
                  key={step.id}
                  onClick={() => onSelectStep(step.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-full transition-all flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                    isActive
                      ? "bg-brand-500 text-white font-semibold shadow-xs"
                      : isPast
                      ? "bg-white text-slate-600 border border-slate-200"
                      : "bg-white text-slate-500 border border-slate-200"
                  }`}
                >
                  <span
                    className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold ${
                      isActive
                        ? "bg-white/20 text-white"
                        : isPast
                        ? "bg-brand-50 text-brand-500"
                        : "bg-slate-100 text-slate-400"
                    }`}
                  >
                    {idx + 1}
                  </span>
                  <span>{step.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
