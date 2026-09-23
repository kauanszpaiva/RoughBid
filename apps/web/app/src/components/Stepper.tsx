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
    <div className="hidden md:flex items-center border-y border-[#151713] bg-[#f4f1e8] select-none">
      <span className="pr-4 py-2 font-mono text-[9px] uppercase tracking-[.18em] text-[#5d6258]">
        Bid sequence
      </span>
      {steps.map((step) => {
        const isActive = step.id === currentStep;
        return (
          <button
            key={step.id}
            onClick={() => onSelectStep(step.id)}
            aria-current={isActive ? "step" : undefined}
            className={`group min-h-10 px-3.5 border-l border-[#151713] font-mono text-[9px] uppercase tracking-[.12em] transition-colors cursor-pointer ${
              isActive
                ? "bg-[#2563eb] text-[#11130f]"
                : "text-[#5d6258] hover:bg-[#151713] hover:text-[#2563eb]"
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
