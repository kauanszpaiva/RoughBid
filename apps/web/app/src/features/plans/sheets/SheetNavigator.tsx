import { useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';
import { Search } from 'lucide-react';
import { fallbackSheetLabel, type PlanSheet } from '../types';
import { SheetThumbnail } from './SheetThumbnail';

type PageReviewPage = {
  pageNumber: number;
  jobId?: string | null;
  status: string;
  processingError?: string | null;
  findingCount?: number | null;
};

type Props = {
  pdf: PDFDocumentProxy | null;
  activePage: number;
  onSelectPage: (page: number) => void;
  sheets?: PlanSheet[] | undefined;
  pageReviewPages?: PageReviewPage[] | undefined;
  collapsed?: boolean;
};

function reviewStatus(page: PageReviewPage | undefined): string | null {
  if (!page) return null;
  if (page.processingError) return 'Needs attention';
  if (page.status === 'needs_review' || page.status === 'ready') return page.findingCount == null ? 'Reviewed' : `${page.findingCount} findings`;
  if (page.status === 'not_started') return 'Not started';
  return 'In progress';
}

export function SheetNavigator({ pdf, activePage, onSelectPage, sheets = [], pageReviewPages, collapsed = false }: Props) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const totalPages = pdf?.numPages ?? 0;
  const known = useMemo(() => new Map(sheets
    .filter(sheet => Number.isInteger(sheet.page) && sheet.page >= 1 && sheet.page <= totalPages && sheet.label.trim())
    .map(sheet => [sheet.page, sheet])), [sheets, totalPages]);
  const review = useMemo(() => new Map((pageReviewPages ?? []).map(page => [page.pageNumber, page])), [pageReviewPages]);

  const allSheets = useMemo(() => Array.from({ length: totalPages }, (_, index) => {
    const page = index + 1;
    return known.get(page) ?? { page, label: fallbackSheetLabel(page) };
  }), [known, totalPages]);

  const visibleSheets = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return allSheets;
    return allSheets.filter(sheet => `${sheet.label} ${sheet.title ?? ''} ${sheet.page}`.toLowerCase().includes(query));
  }, [allSheets, search]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.target === searchRef.current) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    onSelectPage(Math.max(1, Math.min(totalPages, activePage + delta)));
  };

  return (
    <nav aria-label="Plan sheets" onKeyDown={handleKeyDown} className={`${collapsed ? 'w-16' : 'w-52'} flex h-full min-h-0 shrink-0 flex-col border-r border-slate-200 bg-white`}>
      <div className="border-b border-slate-200 p-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">Sheets</span>
          <span className="text-[10px] tabular-nums text-slate-400">{totalPages}</span>
        </div>
        {!collapsed && (
          <label className="mt-2 flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 focus-within:ring-2 focus-within:ring-blue-500">
            <Search className="size-3.5 shrink-0 text-slate-400" />
            <input
              ref={searchRef}
              aria-label="Search sheets"
              placeholder="Search sheets"
              value={search}
              onChange={event => setSearch(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-xs outline-none"
            />
          </label>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="space-y-2">
          {visibleSheets.map(sheet => {
            const selected = sheet.page === activePage;
            const status = reviewStatus(review.get(sheet.page));
            return (
              <button
                key={sheet.page}
                type="button"
                data-sheet-page={sheet.page}
                aria-label={`Open PDF page ${sheet.page}`}
                aria-current={selected ? 'page' : undefined}
                onClick={() => onSelectPage(sheet.page)}
                className={`w-full rounded-lg border p-1.5 text-left transition ${selected ? 'border-blue-400 bg-blue-50 ring-1 ring-blue-200' : 'border-transparent hover:border-slate-200 hover:bg-slate-50'}`}
              >
                {!collapsed && pdf && <SheetThumbnail pdf={pdf} pageNumber={sheet.page} label={sheet.label} />}
                <div className={`${collapsed ? 'text-center' : 'mt-1.5'} min-w-0`}>
                  <div className={`truncate text-xs font-semibold ${selected ? 'text-blue-800' : 'text-slate-800'}`}>{sheet.label}</div>
                  {!collapsed && sheet.title && <div className="truncate text-[10px] text-slate-500">{sheet.title}</div>}
                  {!collapsed && status && <div className="mt-0.5 truncate text-[10px] text-slate-500">{status}</div>}
                </div>
              </button>
            );
          })}
          {totalPages === 0 && <p className="px-1 py-4 text-center text-xs text-slate-400">No sheets</p>}
          {totalPages > 0 && visibleSheets.length === 0 && <p className="px-1 py-4 text-center text-xs text-slate-400">No matching sheets</p>}
        </div>
      </div>
    </nav>
  );
}
