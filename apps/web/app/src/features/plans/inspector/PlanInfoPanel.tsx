import type { ChangeEventHandler } from 'react';
import { Download, Edit2, History, Trash2, Upload } from 'lucide-react';
import type { PlanRevision } from '../../../types';

export type PlanInfoPanelProps = {
  currentRevision: PlanRevision;
  revisions: PlanRevision[];
  canWrite: boolean;
  editingFileName?: boolean;
  fileNameDraft?: string;
  onFileNameDraftChange?: ((value: string) => void) | undefined;
  onStartRename?: (() => void) | undefined;
  onSaveRename?: (() => void) | undefined;
  onCancelRename?: (() => void) | undefined;
  onUploadRevision?: ChangeEventHandler<HTMLInputElement> | undefined;
  onDownloadOriginal?: (() => void) | undefined;
  onDeletePlan?: (() => void) | undefined;
  onOpenRevisions?: (() => void) | undefined;
  onSetCurrentRevision?: ((revisionId: string) => void) | undefined;
};

const actionClass = 'inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40';

export function PlanInfoPanel({
  currentRevision,
  revisions,
  canWrite,
  editingFileName = false,
  fileNameDraft = '',
  onFileNameDraftChange,
  onStartRename,
  onSaveRename,
  onCancelRename,
  onUploadRevision,
  onDownloadOriginal,
  onDeletePlan,
  onOpenRevisions,
  onSetCurrentRevision,
}: PlanInfoPanelProps) {
  return (
    <section aria-label="Plan information" className="min-h-0 overflow-y-auto p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900">Plan</h3>
          <p className="mt-1 text-[11px] text-slate-500">File, revision, and document actions.</p>
        </div>
        <span className="shrink-0 rounded bg-blue-50 px-2 py-1 text-[10px] font-bold text-blue-700">REV {currentRevision.revisionNumber}</span>
      </div>

      <dl className="space-y-3 rounded-lg border border-slate-200 bg-white p-3 text-xs">
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">File</dt>
          <dd className="mt-1 text-slate-900">
            {editingFileName ? (
              <div className="space-y-2">
                <input aria-label="Plan file name" value={fileNameDraft} onChange={event => onFileNameDraftChange?.(event.target.value)} className="h-9 w-full rounded-md border border-slate-200 px-2 outline-none focus:ring-2 focus:ring-blue-500" />
                <div className="flex gap-2">
                  <button type="button" className={actionClass} onClick={onSaveRename} disabled={!canWrite || !fileNameDraft.trim()}>Save</button>
                  <button type="button" className={actionClass} onClick={onCancelRename}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 break-words font-medium">{currentRevision.fileName}</span>
                {canWrite && onStartRename && <button type="button" aria-label="Rename plan file" className="shrink-0 rounded p-1 text-slate-500 hover:bg-slate-100" onClick={onStartRename}><Edit2 className="size-3.5" /></button>}
              </div>
            )}
          </dd>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Pages</dt><dd className="mt-1 font-medium text-slate-800">{currentRevision.pages || 'Unknown'}</dd></div>
          <div><dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Size</dt><dd className="mt-1 font-medium text-slate-800">{currentRevision.fileSize}</dd></div>
          <div><dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Uploaded</dt><dd className="mt-1 font-medium text-slate-800">{currentRevision.uploadDate}</dd></div>
          <div><dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">By</dt><dd className="mt-1 font-medium text-slate-800">{currentRevision.uploadedBy}</dd></div>
        </div>
        {(currentRevision.processingStatus || currentRevision.aiPlanStatus) && (
          <div>
            <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Status</dt>
            <dd className="mt-1 flex flex-wrap gap-1.5">
              {currentRevision.processingStatus && <span className="rounded bg-slate-100 px-2 py-1 text-[10px] font-semibold text-slate-600">File {currentRevision.processingStatus}</span>}
              {currentRevision.aiPlanStatus && <span className="rounded bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-700">AI {currentRevision.aiPlanStatus.replace('_', ' ')}</span>}
            </dd>
          </div>
        )}
      </dl>

      <div className="mt-3 grid grid-cols-2 gap-2">
        {onUploadRevision && canWrite && (
          <label className={`${actionClass} cursor-pointer`}>
            <Upload className="size-4" /> Upload revision
            <input type="file" accept="application/pdf,.pdf" className="sr-only" onChange={onUploadRevision} />
          </label>
        )}
        {onDownloadOriginal && <button type="button" className={actionClass} onClick={onDownloadOriginal}><Download className="size-4" /> Download</button>}
        {onOpenRevisions && <button type="button" className={actionClass} onClick={onOpenRevisions}><History className="size-4" /> Revisions</button>}
      </div>

      {revisions.length > 1 && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-white p-2">
          <p className="px-1 pb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Revision history</p>
          <div className="space-y-1">
            {[...revisions].reverse().map(revision => (
              <button
                key={revision.id}
                type="button"
                disabled={!canWrite || revision.isCurrent || !onSetCurrentRevision}
                onClick={() => onSetCurrentRevision?.(revision.id)}
                className={`flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-xs ${revision.isCurrent ? 'bg-blue-50 text-blue-800' : 'hover:bg-slate-50 disabled:opacity-60'}`}
              >
                <span className="min-w-0 truncate">REV {revision.revisionNumber} · {revision.fileName}</span>
                {revision.isCurrent && <span className="ml-2 shrink-0 text-[10px] font-semibold">Current</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {canWrite && onDeletePlan && (
        <div className="mt-5 border-t border-red-100 pt-3">
          <button type="button" onClick={onDeletePlan} className="inline-flex min-h-9 w-full items-center justify-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 text-xs font-semibold text-red-700 hover:bg-red-100">
            <Trash2 className="size-4" /> Remove plan set
          </button>
        </div>
      )}
    </section>
  );
}
