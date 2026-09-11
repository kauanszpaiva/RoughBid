import { useState } from 'react';
import type { PlanAnnotation } from '../../../types';
import type { PlanReadingFinding } from '../../../services/api';
import type { PlansInspectorTab } from '../types';
import { FindingsPanel } from './FindingsPanel';
import { NotesPanel } from './NotesPanel';
import { PageReviewPanel, type PageReviewPanelProps } from './PageReviewPanel';
import { PlanInfoPanel, type PlanInfoPanelProps } from './PlanInfoPanel';
import { TakeoffPanel } from './TakeoffPanel';

export type PlanInspectorProps = {
  findings: PlanReadingFinding[];
  selectedFindingId: string | null;
  onSelectFinding: (findingId: string) => void;
  annotations: PlanAnnotation[];
  selectedAnnotationId: string | null;
  onSelectAnnotation: (annotationId: string) => void;
  planInfo: PlanInfoPanelProps;
  pageReview?: PageReviewPanelProps | null | undefined;
  className?: string;
};

const tabs: Array<{ id: PlansInspectorTab; label: string }> = [
  { id: 'ai', label: 'AI' },
  { id: 'takeoff', label: 'Takeoff' },
  { id: 'notes', label: 'Notes' },
  { id: 'plan', label: 'Plan' },
];

export function PlanInspector({
  findings,
  selectedFindingId,
  onSelectFinding,
  annotations,
  selectedAnnotationId,
  onSelectAnnotation,
  planInfo,
  pageReview,
  className = '',
}: PlanInspectorProps) {
  const [activeTab, setActiveTab] = useState<PlansInspectorTab>('ai');
  const [aiView, setAiView] = useState<'findings' | 'pageReview'>('findings');

  return (
    <aside aria-label="Plan inspector" className={`flex h-full min-h-0 w-full flex-col border-l border-slate-200 bg-white ${className}`}>
      <div role="tablist" aria-label="Plan inspector sections" className="grid grid-cols-4 border-b border-slate-200 bg-slate-50 p-1">
        {tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`plan-inspector-${tab.id}`}
            id={`plan-inspector-tab-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            className={`rounded-md px-2 py-2 text-[11px] font-semibold transition ${activeTab === tab.id ? 'bg-white text-slate-950 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-800'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1">
        <div id="plan-inspector-ai" role="tabpanel" aria-labelledby="plan-inspector-tab-ai" hidden={activeTab !== 'ai'} className="h-full min-h-0">
          {pageReview && (
            <div className="flex border-b border-slate-200 bg-white p-2" role="tablist" aria-label="AI inspector views">
              <button type="button" role="tab" aria-selected={aiView === 'findings'} onClick={() => setAiView('findings')} className={`flex-1 rounded-md px-2 py-1.5 text-xs font-semibold ${aiView === 'findings' ? 'bg-blue-50 text-blue-700' : 'text-slate-500 hover:bg-slate-50'}`}>Findings</button>
              <button type="button" role="tab" aria-selected={aiView === 'pageReview'} onClick={() => setAiView('pageReview')} className={`flex-1 rounded-md px-2 py-1.5 text-xs font-semibold ${aiView === 'pageReview' ? 'bg-blue-50 text-blue-700' : 'text-slate-500 hover:bg-slate-50'}`}>Page Review</button>
            </div>
          )}
          <div hidden={Boolean(pageReview) && aiView !== 'findings'} className="h-full min-h-0">
            <FindingsPanel findings={findings} selectedFindingId={selectedFindingId} onSelectFinding={onSelectFinding} />
          </div>
          {pageReview && <div hidden={aiView !== 'pageReview'} className="h-full min-h-0 overflow-y-auto"><PageReviewPanel {...pageReview} /></div>}
        </div>

        <div id="plan-inspector-takeoff" role="tabpanel" aria-labelledby="plan-inspector-tab-takeoff" hidden={activeTab !== 'takeoff'} className="h-full min-h-0">
          <TakeoffPanel findings={findings} onSelectFinding={onSelectFinding} />
        </div>

        <div id="plan-inspector-notes" role="tabpanel" aria-labelledby="plan-inspector-tab-notes" hidden={activeTab !== 'notes'} className="h-full min-h-0">
          <NotesPanel annotations={annotations} selectedAnnotationId={selectedAnnotationId} onSelectAnnotation={onSelectAnnotation} />
        </div>

        <div id="plan-inspector-plan" role="tabpanel" aria-labelledby="plan-inspector-tab-plan" hidden={activeTab !== 'plan'} className="h-full min-h-0">
          <PlanInfoPanel {...planInfo} />
        </div>
      </div>
    </aside>
  );
}
