import { useMemo, useState } from 'react';
import { AlertTriangle, MapPin, Search } from 'lucide-react';
import type { PlanReadingFinding, PlanReadingFindingType } from '../../../services/api';
import { getValidFindingBox, getValidFindingPoint } from '../utils/findingGeometry';

export type FindingsPanelProps = {
  findings: PlanReadingFinding[];
  selectedFindingId: string | null;
  onSelectFinding: (findingId: string) => void;
};

const findingTypes: Array<{ value: 'all' | PlanReadingFindingType; label: string }> = [
  { value: 'all', label: 'All findings' },
  { value: 'room', label: 'Rooms & areas' },
  { value: 'measurement', label: 'Measurements' },
  { value: 'material', label: 'Materials' },
  { value: 'labor', label: 'Labor scope' },
  { value: 'risk', label: 'Risks' },
  { value: 'question', label: 'Questions' },
  { value: 'scope_note', label: 'Scope notes' },
  { value: 'symbol', label: 'Symbols' },
];

const mapped = (finding: PlanReadingFinding) => Boolean(getValidFindingBox(finding) || getValidFindingPoint(finding));

export function FindingsPanel({ findings, selectedFindingId, onSelectFinding }: FindingsPanelProps) {
  const [search, setSearch] = useState('');
  const [type, setType] = useState<'all' | PlanReadingFindingType>('all');
  const reviewFindings = useMemo(() => findings.filter(finding => finding.status !== 'rejected'), [findings]);
  const visibleFindings = useMemo(() => {
    const query = search.trim().toLowerCase();
    return reviewFindings.filter(finding => {
      if (type !== 'all' && finding.finding_type !== type) return false;
      if (!query) return true;
      return `${finding.label} ${finding.source_excerpt ?? ''} ${finding.value_text ?? ''}`.toLowerCase().includes(query);
    });
  }, [reviewFindings, search, type]);
  const selected = reviewFindings.find(finding => finding.id === selectedFindingId) ?? null;

  return (
    <section aria-label="AI findings" className="flex min-h-0 flex-col">
      <div className="space-y-2 border-b border-slate-200 p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">AI Findings</h3>
            <p className="text-[11px] text-slate-500">{reviewFindings.length} items requiring source review</p>
          </div>
        </div>
        <label className="flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 focus-within:ring-2 focus-within:ring-blue-500">
          <Search className="size-3.5 text-slate-400" />
          <input aria-label="Search plan findings" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search findings" className="min-w-0 flex-1 bg-transparent text-xs outline-none" />
        </label>
        <select aria-label="Finding type" value={type} onChange={event => setType(event.target.value as 'all' | PlanReadingFindingType)} className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-xs">
          {findingTypes.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="space-y-1.5">
          {visibleFindings.map(finding => {
            const isMapped = mapped(finding);
            const isSelected = finding.id === selectedFindingId;
            const isRisk = finding.finding_type === 'risk';
            return (
              <button
                key={finding.id}
                type="button"
                aria-label={`Open finding ${finding.label}`}
                aria-pressed={isSelected}
                onClick={() => onSelectFinding(finding.id)}
                className={`w-full rounded-lg border p-2.5 text-left transition ${isSelected ? 'border-blue-400 bg-blue-50 ring-1 ring-blue-200' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
              >
                <div className="flex items-start gap-2">
                  {isRisk ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden="true" /> : <MapPin className={`mt-0.5 size-4 shrink-0 ${isMapped ? 'text-emerald-600' : 'text-slate-400'}`} aria-hidden="true" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <span className="truncate text-xs font-semibold text-slate-900">{finding.label}</span>
                      <span className="shrink-0 text-[10px] font-semibold tabular-nums text-slate-500">{Math.round(finding.confidence * 100)}%</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-slate-500">
                      <span>{isRisk ? 'Risk' : finding.finding_type.replace('_', ' ')}</span>
                      <span>{finding.page_number ? `Page ${finding.page_number}` : 'Page unknown'}</span>
                      <span className={isMapped ? 'text-emerald-700' : 'text-slate-500'}>{isMapped ? 'Mapped' : 'Unmapped'}</span>
                      {finding.quantity !== null && <span>{finding.quantity} {finding.unit ?? ''}</span>}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
          {visibleFindings.length === 0 && <p className="p-4 text-center text-xs text-slate-500">No matching findings.</p>}
        </div>
      </div>

      {selected && (
        <div className="border-t border-slate-200 bg-slate-50 p-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <strong className="truncate text-slate-900">{selected.label}</strong>
            <span className="text-[10px] font-semibold text-slate-500">{mapped(selected) ? 'Mapped source' : 'Unmapped source'}</span>
          </div>
          {selected.source_excerpt && <p className="mt-2 text-slate-600">{selected.source_excerpt}</p>}
          {selected.value_text && <p className="mt-2 text-slate-700">{selected.value_text}</p>}
          {selected.quantity !== null && <p className="mt-2 font-semibold text-slate-700">{selected.quantity} {selected.unit ?? ''}</p>}
        </div>
      )}
    </section>
  );
}
