import React from 'react';
import type { PlanReadingFinding } from '../../../services/api';
import { getValidFindingBox, getValidFindingPoint } from '../utils/findingGeometry';

type Props = {
  findings: PlanReadingFinding[];
  pageNumber: number;
  selectedFindingId: string | null;
  showAiMarkers: boolean;
  showFindingHighlights: boolean;
  onSelectFinding?: ((findingId: string) => void) | undefined;
};

export function FindingOverlay({ findings, pageNumber, selectedFindingId, showAiMarkers, showFindingHighlights, onSelectFinding }: Props) {
  const pageFindings = findings.filter(finding => finding.status !== 'rejected' && finding.page_number === pageNumber);

  return (
    <div className="absolute inset-0 pointer-events-none" aria-hidden={pageFindings.length === 0 ? true : undefined}>
      {pageFindings.map(finding => {
        const box = getValidFindingBox(finding);
        const point = getValidFindingPoint(finding);
        if (!box && !point) return null;
        const selected = selectedFindingId === finding.id;
        const risk = finding.finding_type === 'risk';
        return (
          <React.Fragment key={finding.id}>
            {showFindingHighlights && box && (
              <button
                type="button"
                data-finding-id={finding.id}
                aria-label={`AI finding area: ${finding.label}`}
                aria-pressed={selected}
                onClick={event => { event.stopPropagation(); onSelectFinding?.(finding.id); }}
                className={`absolute pointer-events-auto border-2 ${selected ? 'ring-2 ring-offset-1' : 'opacity-60 hover:opacity-100'} ${risk ? 'border-amber-500 ring-amber-400 bg-amber-200/10' : 'border-emerald-500 ring-emerald-400 bg-emerald-200/10'}`}
                style={{ left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${box[2] * 100}%`, height: `${box[3] * 100}%` }}
              />
            )}
            {showAiMarkers && point && (
              <button
                type="button"
                data-finding-marker-id={finding.id}
                aria-label={`AI marker: ${finding.label}`}
                aria-pressed={selected}
                onClick={event => { event.stopPropagation(); onSelectFinding?.(finding.id); }}
                className={`absolute pointer-events-auto -translate-x-1/2 -translate-y-1/2 size-5 rounded-full border-2 border-white shadow-sm ${risk ? 'bg-amber-500' : 'bg-emerald-600'} ${selected ? 'ring-2 ring-offset-1 ring-blue-500' : ''}`}
                style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
              >
                <span className="sr-only">{finding.label}</span>
              </button>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
