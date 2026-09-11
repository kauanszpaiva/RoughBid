import { FileText } from 'lucide-react';
import type { PlanAnnotation } from '../../../types';

export type NotesPanelProps = {
  annotations: PlanAnnotation[];
  selectedAnnotationId: string | null;
  onSelectAnnotation: (annotationId: string) => void;
};

export function NotesPanel({ annotations, selectedAnnotationId, onSelectAnnotation }: NotesPanelProps) {
  const sorted = [...annotations].sort((a, b) => a.page - b.page || a.text.localeCompare(b.text));

  return (
    <section aria-label="Plan notes" className="min-h-0 overflow-y-auto p-3">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-slate-900">Notes</h3>
        <p className="mt-1 text-[11px] text-slate-500">Manual annotations anchored to physical PDF pages.</p>
      </div>
      <div className="space-y-2">
        {sorted.map(note => {
          const selected = note.id === selectedAnnotationId;
          return (
            <button
              key={note.id}
              type="button"
              aria-label={`Open note on page ${note.page}`}
              aria-pressed={selected}
              onClick={() => onSelectAnnotation(note.id)}
              className={`w-full rounded-lg border p-3 text-left transition ${selected ? 'border-blue-400 bg-blue-50 ring-1 ring-blue-200' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
            >
              <div className="flex items-start gap-2">
                <FileText className="mt-0.5 size-4 shrink-0 text-blue-600" aria-hidden="true" />
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Page {note.page}</div>
                  <p className="mt-1 text-xs text-slate-800">{note.text}</p>
                </div>
              </div>
            </button>
          );
        })}
        {sorted.length === 0 && <p className="rounded-lg border border-dashed border-slate-200 p-5 text-center text-xs text-slate-500">No manual notes yet.</p>}
      </div>
    </section>
  );
}
