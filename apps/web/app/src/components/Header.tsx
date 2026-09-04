import React from "react";
import { Bell, FileDown, Plus, ChevronLeft, Menu, Home } from "lucide-react";
import { Project, UserProfile } from "../types";

export type ProjectStep = "plans" | "quantities" | "estimate" | "review" | "export";

interface HeaderProps {
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
}

export const Header: React.FC<HeaderProps> = ({
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

  return (
    <div className="flex flex-col shrink-0 z-20 select-none bg-white font-sans">
      {/* Primary Header Bar */}
      <header className="h-14 md:h-16 border-b border-[#e5e7eb] px-4 md:px-8 flex items-center justify-between">
        {/* Left: Mobile Hamburger & Project / App Title */}
        <div className="flex items-center gap-2.5 md:gap-3 min-w-0">
          {/* Mobile hamburger menu toggle */}
          <button
            onClick={onToggleMobileMenu}
            className="p-1.5 -ml-1 text-[#374151] hover:text-[#111827] hover:bg-[#f3f4f6] rounded-md transition md:hidden cursor-pointer"
            aria-label="Open Navigation Menu"
          >
            <Menu className="w-5 h-5" />
          </button>

          {project ? (
            <div className="flex items-center gap-1.5 md:gap-2.5 min-w-0">
              <button
                onClick={onBackToProjects}
                className="p-1 text-[#6b7280] hover:text-[#111827] hover:bg-[#f3f4f6] rounded-md transition cursor-pointer shrink-0"
                title="Back to all projects"
                aria-label="Back to projects"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <div className="flex items-center gap-2 min-w-0">
                <h2 className="text-sm md:text-lg font-bold text-[#111827] tracking-tight truncate max-w-[140px] sm:max-w-[220px] md:max-w-none">
                  {project.name}
                </h2>
                <span className="hidden sm:inline-block px-2 py-0.5 bg-[#f3f4f6] text-[#6b7280] text-[10px] font-bold rounded uppercase shrink-0">
                  {project.id.toUpperCase().slice(0, 8)}
                </span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 bg-[#f8fafc] border border-blue-200 rounded flex items-center justify-center shadow-xs md:hidden relative">
                <span className="text-[#111827] font-black text-base leading-none">R</span>
                <Home className="w-3 h-3 text-[#2563eb] absolute bottom-0.5 right-0.5" />
              </div>
              <h2 className="text-base md:text-lg font-bold text-[#111827] tracking-tight">
                <span className="md:hidden">ROUGH<span className="text-[#2563eb]">bid</span></span>
                <span className="hidden md:inline">Dashboard</span>
              </h2>
            </div>
          )}
        </div>

        {/* Center (Desktop only): Pill Stepper navigation if project is active */}
        {project && (
          <div className="hidden md:flex items-center bg-[#f3f4f6] rounded-full p-1">
            {steps.map((step) => {
              const isActive = activeStep === step.id;
              return (
                <button
                  key={step.id}
                  onClick={() => onSelectStep(step.id)}
                  className={`px-4 py-1.5 text-xs font-semibold rounded-full transition-all cursor-pointer ${
                    isActive
                      ? "bg-white text-[#2563eb] shadow-xs"
                      : "text-[#6b7280] hover:text-[#111827]"
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
                className="hidden sm:flex text-[#374151] bg-[#f3f4f6] hover:bg-[#e5e7eb] px-3 py-1.5 rounded-md text-xs font-semibold items-center gap-1.5 transition cursor-pointer"
              >
                <FileDown className="w-3.5 h-3.5 text-[#6b7280]" />
                <span>Export PDF</span>
              </button>

              <button
                onClick={onCreateEstimate}
                className="hidden md:flex bg-[#2563eb] text-white px-3.5 py-1.5 rounded-md text-xs font-semibold hover:bg-[#1d4ed8] shadow-xs items-center gap-1.5 transition cursor-pointer"
              >
                <span>Create Estimate</span>
              </button>

              {/* Mobile quick export icon button */}
              <button
                onClick={onExportPDF}
                className="sm:hidden p-1.5 text-[#374151] bg-[#f3f4f6] hover:bg-[#e5e7eb] rounded-md transition cursor-pointer"
                title="Export PDF"
              >
                <FileDown className="w-4 h-4 text-[#4b5563]" />
              </button>
            </>
          ) : (
            <button
              onClick={onOpenNewProject}
              className="flex items-center gap-1.5 px-3 py-1.5 md:px-3.5 md:py-1.5 bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-md text-xs font-semibold transition shadow-xs cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Project</span>
            </button>
          )}

          <button
            className="hidden sm:block p-2 text-[#9ca3af] hover:text-[#111827] hover:bg-[#f3f4f6] rounded-full transition relative cursor-pointer"
            title="Notifications"
          >
            <Bell className="w-4 h-4" />
            <span className="w-1.5 h-1.5 bg-[#2563eb] rounded-full absolute top-1.5 right-1.5" />
          </button>

          {/* User profile avatar button */}
          <button
            onClick={onOpenAuth}
            className="w-8 h-8 rounded-full bg-[#d1d5db] hover:bg-[#9ca3af] text-[#374151] font-bold text-xs flex items-center justify-center transition cursor-pointer shrink-0"
            title={user?.name || "Account Profile"}
          >
            {userInitials}
          </button>
        </div>
      </header>

      {/* Mobile Project Horizontal Stepper Bar */}
      {project && (
        <div className="md:hidden bg-[#f9fafb] border-b border-[#e5e7eb] px-3 py-2 overflow-x-auto no-scrollbar">
          <div className="flex items-center gap-1.5 min-w-max mx-auto justify-center">
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
                      ? "bg-[#2563eb] text-white font-semibold shadow-xs"
                      : isPast
                      ? "bg-white text-[#374151] border border-[#e5e7eb]"
                      : "bg-white text-[#6b7280] border border-[#e5e7eb]"
                  }`}
                >
                  <span
                    className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold ${
                      isActive
                        ? "bg-white/20 text-white"
                        : isPast
                        ? "bg-[#eff6ff] text-[#2563eb]"
                        : "bg-[#f3f4f6] text-[#9ca3af]"
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
