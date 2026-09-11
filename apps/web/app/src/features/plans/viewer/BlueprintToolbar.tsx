import {
  ChevronLeft,
  ChevronRight,
  Expand,
  Hand,
  Layers,
  MapPin,
  Minus,
  Plus,
  Scan,
  StretchHorizontal,
} from 'lucide-react';
import type { PlansViewMode } from '../types';

type Props = {
  pageNumber: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  zoomPercent: number;
  handTool: boolean;
  canWrite: boolean;
  noteMode: boolean;
  viewMode: PlansViewMode;
  focusMode: boolean;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFitWidth: () => void;
  onFitPage: () => void;
  onActualSize: () => void;
  onToggleHand: () => void;
  onToggleLayers: () => void;
  onToggleNote: () => void;
  onViewModeChange: (mode: PlansViewMode) => void;
  onToggleFocus: () => void;
};

const iconButton = 'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-30';

export function BlueprintToolbar({
  pageNumber,
  totalPages,
  onPageChange,
  zoomPercent,
  handTool,
  canWrite,
  noteMode,
  viewMode,
  focusMode,
  onZoomOut,
  onZoomIn,
  onFitWidth,
  onFitPage,
  onActualSize,
  onToggleHand,
  onToggleLayers,
  onToggleNote,
  onViewModeChange,
  onToggleFocus,
}: Props) {
  const optionCount = Math.max(1, totalPages);

  return (
    <div role="toolbar" aria-label="Blueprint controls" className="flex min-h-11 flex-wrap items-center gap-1 border-b border-slate-200 bg-white px-2 py-1.5 text-xs shadow-sm">
      <div className="flex items-center gap-0.5 border-r border-slate-200 pr-2">
        <button type="button" aria-label="Previous PDF page" className={iconButton} disabled={totalPages === 0 || pageNumber <= 1} onClick={() => onPageChange(pageNumber - 1)}>
          <ChevronLeft className="size-4" />
        </button>
        <label className="flex items-center gap-1 text-slate-500">
          <span className="sr-only">PDF page</span>
          <select
            aria-label="PDF page"
            value={Math.min(optionCount, Math.max(1, pageNumber))}
            disabled={totalPages === 0}
            onChange={event => onPageChange(Number(event.target.value))}
            className="h-8 rounded-md border border-slate-200 bg-white px-2 font-semibold tabular-nums text-slate-800 outline-none focus:ring-2 focus:ring-blue-500"
          >
            {Array.from({ length: optionCount }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
          </select>
          <span className="whitespace-nowrap">/ {totalPages}</span>
        </label>
        <button type="button" aria-label="Next PDF page" className={iconButton} disabled={totalPages === 0 || pageNumber >= totalPages} onClick={() => onPageChange(pageNumber + 1)}>
          <ChevronRight className="size-4" />
        </button>
      </div>

      <button type="button" aria-label="Hand tool" aria-pressed={handTool} className={`${iconButton} ${handTool ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200' : ''}`} onClick={onToggleHand}>
        <Hand className="size-4" />
      </button>

      <div className="flex items-center gap-0.5 border-x border-slate-200 px-2">
        <button type="button" aria-label="Zoom out" className={iconButton} disabled={zoomPercent <= 25} onClick={onZoomOut}>
          <Minus className="size-4" />
        </button>
        <button type="button" aria-label="Actual size" className="h-8 min-w-12 rounded-md px-2 font-semibold tabular-nums text-slate-700 hover:bg-slate-100" onClick={onActualSize}>
          {zoomPercent}%
        </button>
        <button type="button" aria-label="Zoom in" className={iconButton} disabled={zoomPercent >= 500} onClick={onZoomIn}>
          <Plus className="size-4" />
        </button>
        <button type="button" aria-label="Fit width" className={iconButton} onClick={onFitWidth}>
          <StretchHorizontal className="size-4" />
        </button>
        <button type="button" aria-label="Fit page" className={iconButton} onClick={onFitPage}>
          <Scan className="size-4" />
        </button>
      </div>

      <button type="button" aria-label="Layers" aria-haspopup="menu" className={iconButton} onClick={onToggleLayers}>
        <Layers className="size-4" />
      </button>
      <button type="button" aria-label="Add note" aria-pressed={noteMode} disabled={!canWrite} className={`${iconButton} ${noteMode ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200' : ''}`} onClick={onToggleNote}>
        <MapPin className="size-4" />
      </button>

      <label className="ml-auto flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 font-medium text-slate-600">
        <span className="hidden sm:inline">View</span>
        <select aria-label="View mode" value={viewMode} onChange={event => onViewModeChange(event.target.value as PlansViewMode)} className="bg-transparent font-semibold text-slate-800 outline-none">
          <option value="single">Single</option>
          <option value="continuous">Continuous</option>
        </select>
      </label>

      <button type="button" aria-label="Focus mode" aria-pressed={focusMode} className={`${iconButton} ${focusMode ? 'bg-slate-900 text-white hover:bg-slate-800 hover:text-white' : ''}`} onClick={onToggleFocus}>
        {focusMode ? <Expand className="size-4" /> : <Expand className="size-4" />}
      </button>
    </div>
  );
}
