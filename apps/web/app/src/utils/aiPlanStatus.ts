import type { FullTakeoffRun } from '../services/api.ts';

export type AiPlanPresentationStatus = 'queued' | 'processing' | 'needs_review' | 'ready' | 'failed' | 'cancelled';

export function presentAiPlanStatus(status: AiPlanPresentationStatus) {
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
  return status === 'queued' || status === 'processing';
}

/** Checkpoints include blocked passes; a saved count is never quantity/price certification. */
export function presentFullTakeoffStatus(run: Pick<FullTakeoffRun, 'status' | 'progress' | 'output_summary' | 'cancel_requested_at' | 'sheets'>) {
  const completed = run.progress?.completed;
  const total = run.progress?.total;
  const savedProgress = Number.isSafeInteger(completed) && completed! >= 0
    && Number.isSafeInteger(total) && total! > 0 && completed! <= total!
    ? `${completed}/${total} checkpoints saved` : 'Checkpoint totals are not available yet';
  const savedSheets = run.sheets;
  const uncertainPass = savedSheets?.some(sheet => sheet.passes.some(pass => pass.status === 'processing' || pass.status === 'failed')) ?? true;
  const canRestart = ['queued', 'failed', 'cancelled'].includes(run.status) && !uncertainPass;
  let notice: string;
  if (run.cancel_requested_at && isAiPlanInFlight(run.status)) {
    notice = 'Cancellation requested. The current provider attempt may still finish; no new stage will start.';
  } else if (run.status === 'queued') {
    notice = 'Full Takeoff V2 is queued. You can leave this page; saved progress remains recoverable.';
  } else if (run.status === 'processing') {
    notice = `Full Takeoff V2 is reading the plan. ${savedProgress}. You can leave this page; reading continues in the background.`;
  } else if (run.status === 'cancelled') {
    notice = 'Full Takeoff V2 was cancelled. Saved evidence remains available; an in-flight provider attempt may still finish.';
  } else if (run.status === 'failed') {
    notice = 'Full Takeoff V2 stopped. Inspect saved evidence and reconcile uncertain attempts before resuming.';
  } else if (run.output_summary?.takeoff_v2?.releaseStatus === 'review_ready') {
    notice = 'Full Takeoff V2 evidence is saved for human review. Measured quantities and sourced prices still require verification.';
  } else {
    notice = 'Full Takeoff V2 evidence is saved with unresolved blockers. Review each sheet and stage; quantities and prices are not verified.';
  }
  return {
    notice, savedProgress, canRestart,
    canCancel: isAiPlanInFlight(run.status) && !run.cancel_requested_at,
    finished: run.status === 'needs_review' || run.status === 'ready',
    revisionNote: run.status === 'needs_review' || run.status === 'ready'
      ? 'Full Takeoff V2 checkpoints saved for review. Quantities, prices and release require evidence verification.' : undefined,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const texts = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];

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
