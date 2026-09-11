export type AiPlanPresentationStatus = 'queued' | 'processing' | 'needs_review' | 'ready' | 'failed';

export function presentAiPlanStatus(status: AiPlanPresentationStatus) {
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
