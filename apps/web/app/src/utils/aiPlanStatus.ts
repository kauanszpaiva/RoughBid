import type { FullTakeoffRun, FullTakeoffRegionRectangle } from '../services/api.ts';

export type AiPlanPresentationStatus = 'queued' | 'processing' | 'needs_review' | 'ready' | 'failed' | 'cancelled' | 'waiting_budget';

export function presentAiPlanStatus(status: AiPlanPresentationStatus) {
  if (status === 'waiting_budget') return { finished: false, notice: 'Waiting for processing capacity. Your reading will continue automatically with saved progress.', revisionNote: undefined };
  if (status === 'cancelled') {
    return { finished: false, notice: 'AI plan reading was cancelled. Saved evidence remains available.', revisionNote: undefined };
  }
  if (status === 'failed') {
    return {
      finished: false,
      notice: 'AI plan reading failed. Open the AI Plan Assistant for details.',
      revisionNote: undefined,
    };
  }
  if (status === 'needs_review' || status === 'ready') {
    return {
      finished: true,
      notice: 'AI processing finished - partial findings are ready to review. Complete takeoff coverage is not verified.',
      revisionNote: 'AI findings saved for review. Complete takeoff coverage is not verified.',
    };
  }
  if (status === 'queued') {
    return {
      finished: false,
      notice: 'AI plan reading is queued. You can leave this page; it will continue in the background.',
      revisionNote: undefined,
    };
  }
  return {
    finished: false,
    notice: 'AI plan reading is processing. You can leave this page; it will continue in the background.',
    revisionNote: undefined,
  };
}

export function isAiPlanInFlight(status: string): boolean {
  return status === 'queued' || status === 'processing' || status === 'waiting_budget';
}

/** Checkpoints include blocked passes; a saved count is never quantity/price certification. */
export function presentFullTakeoffStatus(run: Pick<FullTakeoffRun, 'status' | 'progress' | 'output_summary' | 'cancel_requested_at' | 'sheets' | 'not_before'>) {
  const completed = run.progress?.completed;
  const total = run.progress?.total;
  const savedProgress = Number.isSafeInteger(completed) && completed! >= 0
    && Number.isSafeInteger(total) && total! > 0 && completed! <= total!
    ? `${completed}/${total} reading steps saved` : 'Reading progress is not available yet';
  const savedSheets = run.sheets;
  const uncertainPass = savedSheets?.some(sheet => sheet.passes.some(pass => pass.status === 'processing' || pass.status === 'failed')) ?? true;
  const canRestart = ['queued', 'failed', 'cancelled'].includes(run.status) && !uncertainPass;
  let notice: string;
  if (run.cancel_requested_at && isAiPlanInFlight(run.status)) {
    notice = 'Cancellation requested. The current provider attempt may still finish; no new stage will start.';
  } else if (run.status === 'waiting_budget') {
    notice = 'Waiting for processing capacity. Your reading will continue automatically with saved progress and no extra charge.';
  } else if (run.status === 'queued') {
    notice = 'Your reading is queued. You can leave this page; saved progress remains recoverable.';
  } else if (run.status === 'processing') {
    notice = `Reading your PDF. ${savedProgress}. You can leave this page; reading continues in the background.`;
  } else if (run.status === 'cancelled') {
    notice = 'Reading canceled. Saved results remain available; work already in progress may still finish.';
  } else if (run.status === 'failed') {
    notice = 'Reading stopped. Review saved results and pending work before resuming.';
  } else if (run.output_summary?.takeoff_v2?.releaseStatus === 'review_ready') {
    notice = 'Results are saved for human review. Measured quantities and sourced prices still require verification.';
  } else {
    notice = 'Results have unresolved items. Review the page results and missing information; quantities and prices are not verified.';
  }
  return {
    notice, savedProgress, canRestart,
    statusLabel: ({ queued: 'Waiting to read', processing: 'Reading', waiting_budget: 'Waiting for processing capacity', needs_review: 'Results need review', ready: 'Results need review', failed: 'Reading stopped', cancelled: 'Reading canceled' })[run.status],
    resumeEstimate: run.status === 'waiting_budget' && run.not_before && Number.isFinite(Date.parse(run.not_before)) ? new Date(run.not_before).toLocaleString() : null,
    canCancel: isAiPlanInFlight(run.status) && !run.cancel_requested_at,
    finished: run.status === 'needs_review' || run.status === 'ready',
    revisionNote: run.status === 'needs_review' || run.status === 'ready'
      ? 'Results saved for review. Quantities and prices require verification.' : undefined,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const texts = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];

export function isFullRegionalPass(passType: string): boolean {
  return ['discipline', 'conflict_detection', 'completeness'].includes(passType);
}
export function fullRegionRectangle(value: unknown): FullTakeoffRegionRectangle | null {
  if (!isRecord(value)) return null;
  const { row, column, rows, columns, x, y, width, height } = value;
  if (![row, column, rows, columns].every(item => Number.isSafeInteger(item) && (item as number) >= 1 && (item as number) <= 3)
    || (row as number) > (rows as number) || (column as number) > (columns as number)
    || ![x, y, width, height].every(item => typeof item === 'number' && Number.isFinite(item))
    || (x as number) < 0 || (y as number) < 0 || (width as number) <= 0 || (height as number) <= 0) return null;
  return { row, column, rows, columns, x, y, width, height } as FullTakeoffRegionRectangle;
}
/** Region records locate saved evidence; they never establish measured coverage. */
export function presentFullTakeoffRegions(checkpoint: unknown) {
  const saved = isRecord(checkpoint) ? checkpoint : {}, coverage = isRecord(saved.source_coverage) ? saved.source_coverage : {};
  const regions: Array<{ key: string; rectangle: FullTakeoffRegionRectangle | null; status: string }> = [];
  const seen = new Set<string>();
  for (const value of Array.isArray(coverage.regions) ? coverage.regions : []) {
    if (!isRecord(value) || typeof value.region_key !== 'string' || !/^r[1-3]c[1-3]g[23]$/.test(value.region_key)) continue;
    const [, row, column, grid] = /^r([1-3])c([1-3])g([23])$/.exec(value.region_key)!;
    if (Number(row) > Number(grid) || Number(column) > Number(grid) || seen.has(value.region_key)) continue;
    seen.add(value.region_key);
    regions.push({ key: value.region_key, rectangle: fullRegionRectangle(value.region), status: typeof value.status === 'string' && value.status.trim() ? value.status : 'status unavailable' });
  }
  const completed = coverage.completed_regions, total = coverage.total_regions;
  const progress = Number.isSafeInteger(completed) && (completed as number) >= 0 && Number.isSafeInteger(total) && (total as number) > 0 && (completed as number) <= (total as number)
    ? `${completed}/${total} regions with saved stage records${(completed as number) < (total as number) ? '; remaining regions are pending' : ''}` : 'Regional totals are not available';
  return { regions, progress };
}

/** Render only evidence fields; do not turn model observations into measured quantities. */
export function presentFullTakeoffCheckpoint(checkpoint: unknown) {
  const saved = isRecord(checkpoint) ? checkpoint : {};
  const observations = (Array.isArray(saved.observations) ? saved.observations : []).flatMap(value =>
    isRecord(value) && typeof value.description === 'string' && value.description.trim()
      ? [{ description: value.description, sourceExcerpt: typeof value.source_excerpt === 'string' && value.source_excerpt.trim() ? value.source_excerpt : null }]
      : []);
  const scale = isRecord(saved.deterministic_scale) ? saved.deterministic_scale : {};
  const calibration = isRecord(scale.calibration) ? scale.calibration : {};
  return {
    observations,
    blockers: [...texts(saved.blockers), ...(typeof saved.error === 'string' && saved.error.trim() ? [saved.error] : [])],
    scaleStatus: typeof calibration.verificationStatus === 'string' ? calibration.verificationStatus : null,
    scaleSources: (Array.isArray(scale.evidence) ? scale.evidence : []).flatMap(value =>
      isRecord(value) && typeof value.sourceExcerpt === 'string' && value.sourceExcerpt.trim() ? [value.sourceExcerpt] : []),
  };
}
