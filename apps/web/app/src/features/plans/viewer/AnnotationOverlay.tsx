import type { PlanAnnotation } from '../../../types';
import type { NormalizedPoint } from '../types';

type Props = {
  annotations: PlanAnnotation[];
  pageNumber: number;
  selectedAnnotationId: string | null;
  showManualNotes: boolean;
  pendingNote?: NormalizedPoint | null;
  onSelectAnnotation?: (annotationId: string) => void;
};

const validCoordinate = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;

export function AnnotationOverlay({ annotations, pageNumber, selectedAnnotationId, showManualNotes, pendingNote, onSelectAnnotation }: Props) {
  if (!showManualNotes && !pendingNote) return null;
  const pageAnnotations = showManualNotes
    ? annotations.filter(annotation => annotation.page === pageNumber && validCoordinate(annotation.x) && validCoordinate(annotation.y))
    : [];

  return (
    <div className="absolute inset-0 pointer-events-none">
      {pageAnnotations.map((annotation, index) => (
        <button
          type="button"
          key={annotation.id}
          data-plan-note-id={annotation.id}
          aria-label={`Plan note: ${annotation.text}`}
          aria-pressed={selectedAnnotationId === annotation.id}
          onClick={event => { event.stopPropagation(); onSelectAnnotation?.(annotation.id); }}
          className={`absolute pointer-events-auto -translate-x-1/2 -translate-y-full rounded-full bg-blue-700 text-white size-6 text-[10px] font-bold shadow ring-offset-1 ${selectedAnnotationId === annotation.id ? 'ring-2 ring-blue-400' : ''}`}
          style={{ left: `${annotation.x * 100}%`, top: `${annotation.y * 100}%` }}
          title={annotation.text}
        >
          {index + 1}
        </button>
      ))}
      {pendingNote && validCoordinate(pendingNote.x) && validCoordinate(pendingNote.y) && (
        <span
          aria-hidden="true"
          className="absolute -translate-x-1/2 -translate-y-full size-6 rounded-full bg-blue-500/70 border-2 border-white shadow"
          style={{ left: `${pendingNote.x * 100}%`, top: `${pendingNote.y * 100}%` }}
        />
      )}
    </div>
  );
}
