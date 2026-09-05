import React from 'react';
import { X } from 'lucide-react';
import type { Project } from '../types';
import { PlanReadingResults } from './PlanReadingResults';

export function AIPlanModal({ project, workspaceId, isOpen, onClose, onUpdateProject }: {
  project: Project; workspaceId: string | null; isOpen: boolean; onClose: () => void; onUpdateProject: (p: Project) => void;
}) {
  if (!isOpen) return null;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
    <div role="dialog" aria-modal="true" aria-label="AI Estimator Assistant" className="w-full max-w-4xl max-h-[90vh] overflow-auto rounded-xl bg-white p-5 space-y-4">
      <div className="flex justify-between items-center"><h2 className="font-bold">AI Estimator Assistant</h2><button onClick={onClose} aria-label="Close assistant"><X /></button></div>
      <PlanReadingResults project={project} workspaceId={workspaceId} onUpdateProject={onUpdateProject} />
    </div>
  </div>;
}
