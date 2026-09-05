import React from "react";
import { Check } from "lucide-react";
import { ProjectStep } from "./Header";

interface StepperProps {
  currentStep: ProjectStep;
  onSelectStep: (step: ProjectStep) => void;
}

export const Stepper: React.FC<StepperProps> = ({ currentStep, onSelectStep }) => {
  const steps: { id: ProjectStep; stepNum: number; label: string }[] = [
    { id: "plans", stepNum: 1, label: "Plans" },
    { id: "quantities", stepNum: 2, label: "Quantities" },
    { id: "estimate", stepNum: 3, label: "Estimate" },
    { id: "review", stepNum: 4, label: "Review" },
    { id: "export", stepNum: 5, label: "Export" },
  ];

  const currentIdx = steps.findIndex((s) => s.id === currentStep);

  return (
    <div className="flex items-center gap-3 py-2 select-none text-xs">
      {steps.map((step, idx) => {
        const isCompleted = idx < currentIdx;
        const isActive = idx === currentIdx;

        return (
          <React.Fragment key={step.id}>
            <button
              onClick={() => onSelectStep(step.id)}
              className="flex items-center gap-2 group cursor-pointer focus:outline-hidden"
            >
              {isCompleted ? (
                <div className="w-5 h-5 rounded-full bg-[#2563eb] text-white flex items-center justify-center text-[10px] font-bold">
                  <Check className="w-3 h-3 stroke-[3]" />
                </div>
              ) : isActive ? (
                <div className="w-5 h-5 rounded-full bg-[#2563eb] text-white flex items-center justify-center text-[11px] font-bold shadow-xs">
                  {step.stepNum}
                </div>
              ) : (
                <div className="w-5 h-5 rounded-full border border-[#d1d5db] text-[#9ca3af] flex items-center justify-center text-[11px] font-medium group-hover:border-[#9ca3af]">
                  {step.stepNum}
                </div>
              )}
              <span
                className={`text-xs ${
                  isActive
                    ? "font-bold text-[#111827]"
                    : isCompleted
                    ? "font-medium text-[#4b5563]"
                    : "font-normal text-[#9ca3af] group-hover:text-[#6b7280]"
                }`}
              >
                {step.label}
              </span>
            </button>

            {idx < steps.length - 1 && (
              <div
                className={`w-8 h-[1.5px] ${
                  idx < currentIdx ? "bg-[#2563eb]" : "bg-[#e5e7eb]"
                }`}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
};
