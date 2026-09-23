import React from "react";
import { ProjectStep } from "./Header";

interface StepperProps {
  currentStep: ProjectStep;
  onSelectStep: (step: ProjectStep) => void;
}

/**
 * Secondary in-page workflow navigation.
 * Completion is deliberately not inferred from page position; the persistent
 * Bid Rail in Header owns readiness/status semantics.
 */
export const Stepper: React.FC<StepperProps> = ({ currentStep, onSelectStep }) => {
  const steps: { id: ProjectStep; stepNum: number; label: string }[] = [
    { id: "plans", stepNum: 1, label: "Plan" },
    { id: "quantities", stepNum: 2, label: "Takeoff" },
    { id: "estimate", stepNum: 3, label: "Cost" },
    { id: "review", stepNum: 4, label: "Check" },
    { id: "export", stepNum: 5, label: "Issue" },
  ];

  return (
    <div className="hidden md:flex items-center border-y border-[#b9b8b0] select-none">
      <span className="pr-4 py-2 font-mono text-[9px] uppercase tracking-[.16em] text-[#777a72]">
        Bid sequence
      </span>
      {steps.map((step) => {
        const isActive = step.id === currentStep;
        return (
          <button
            key={step.id}
            onClick={() => onSelectStep(step.id)}
            aria-current={isActive ? "step" : undefined}
            className={`group min-h-9 px-3 border-l border-[#b9b8b0] font-mono text-[9px] uppercase tracking-[.1em] transition-colors cursor-pointer ${
              isActive
                ? "bg-[#151713] text-[#d9ff43]"
                : "text-[#777a72] hover:bg-[#e2e0d7] hover:text-[#151713]"
            }`}
          >
            <span className="mr-1.5 opacity-60">0{step.stepNum}</span>
            {step.label}
          </button>
        );
      })}
    </div>
  );
};
