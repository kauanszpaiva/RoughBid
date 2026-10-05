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
  const steps: { id: ProjectStep; label: string; helper: string }[] = [
    { id: "plans", label: "Plans", helper: "Upload plans and choose what work you want priced." },
    { id: "quantities", label: "Quantities", helper: "Confirm measured areas, lengths, counts, and takeoff items." },
    { id: "estimate", label: "Estimate", helper: "Add verified material, labor, and equipment costs." },
    { id: "review", label: "Review", helper: "Check scope, pricing, and readiness before client delivery." },
    { id: "export", label: "Export", helper: "Create the client proposal or internal estimate package." },
  ];
  const currentStepIndex = steps.findIndex((step) => step.id === activeStep);
  const currentStepMeta = steps[Math.max(0, currentStepIndex)]!;
  const nextStepMeta = currentStepIndex >= 0 && currentStepIndex < steps.length - 1
    ? steps[currentStepIndex + 1]
    : null;

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

              {nextStepMeta && (
                <button
                  onClick={() => onSelectStep(nextStepMeta.id)}
                  disabled={!canWrite}
                  className="hidden md:flex items-center gap-1.5 rounded-lg bg-brand-500 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                >
                  <span>Next: {nextStepMeta.label}</span>
                </button>
              )}

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

      {project && (
        <section className="border-b border-slate-200 bg-slate-50 px-3 py-3 sm:px-4 md:px-6 xl:px-8" aria-label="Project workflow">
          <div className="mx-auto flex max-w-7xl flex-col gap-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">
                  Project workflow · Step {currentStepIndex + 1} of {steps.length}
                </p>
                <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <strong className="text-sm text-slate-900">{currentStepMeta.label}</strong>
                  <span className="text-xs text-slate-500">{currentStepMeta.helper}</span>
                </div>
              </div>
              {nextStepMeta && (
                <button
                  type="button"
                  onClick={() => onSelectStep(nextStepMeta.id)}
                  disabled={!canWrite}
                  className="hidden shrink-0 rounded-lg bg-brand-500 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50 sm:inline-flex"
                >
                  Continue to {nextStepMeta.label}
                </button>
              )}
            </div>

            <div className="overflow-x-auto no-scrollbar">
              <div className="flex min-w-max items-center gap-1.5">
                {steps.map((step, idx) => {
                  const isActive = activeStep === step.id;
                  const isPast = idx < currentStepIndex;
                  return (
                    <button
                      key={step.id}
                      type="button"
                      onClick={() => onSelectStep(step.id)}
                      aria-current={isActive ? "step" : undefined}
                      className={`flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                        isActive
                          ? "border-brand-500 bg-brand-500 text-white"
                          : isPast
                          ? "border-brand-200 bg-white text-brand-700"
                          : "border-slate-200 bg-white text-slate-500 hover:text-slate-800"
                      }`}
                    >
                      <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${
                        isActive ? "bg-white/20 text-white" : isPast ? "bg-brand-50 text-brand-600" : "bg-slate-100 text-slate-400"
                      }`}>
                        {idx + 1}
                      </span>
                      {step.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {nextStepMeta && (
              <button
                type="button"
                onClick={() => onSelectStep(nextStepMeta.id)}
                disabled={!canWrite}
                className="w-full rounded-lg bg-brand-500 px-3 py-2.5 text-xs font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50 sm:hidden"
              >
                Continue to {nextStepMeta.label}
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
};
