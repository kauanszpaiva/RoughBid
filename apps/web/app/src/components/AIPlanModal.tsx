import { summarizeReadingCoverage, INCOMPLETE_TAKEOFF_NOTICE } from '../../../../../packages/domain/src/reading-coverage.ts';
import React, { useEffect, useRef, useState } from "react";
import {
  Sparkles,
  X,
  Check,
  Plus,
  AlertTriangle,
  HelpCircle,
  FileSearch,
  Layers,
  Loader2,
} from "lucide-react";
import { Project, QuantityItem, UnitType } from "../types";
import {
  ApiError,
  getAiPlanReading,
  getFullTakeoffRun,
  getFullTakeoffCheckpoint,
  cancelFullTakeoffRun,
  restartFullTakeoffRun,
  type FullTakeoffRun,
  type FullTakeoffPass,
  type FullTakeoffCheckpoint,
  setPlanReadingFindingStatus,
  type PlanReadingFinding,
  type PlanReadingJob,
} from "../services/api";
import { TakeoffCoverageDashboard } from "./TakeoffCoverageDashboard";
import { PlanMeasurementPanel } from "./PlanMeasurementPanel";
import { isAiPlanInFlight, presentFullTakeoffCheckpoint, presentFullTakeoffStatus, presentFullTakeoffRegions, isFullRegionalPass, fullRegionRectangle } from "../utils/aiPlanStatus";

interface AIPlanModalProps {
  project: Project;
  workspaceId: string | null;
  isOpen: boolean;
  canWrite?: boolean;
  onClose: () => void;
  onAddQuantityItem: (
    item: Omit<QuantityItem, "id" | "itemNumber">,
  ) => void;
  initialTab?: "analyze" | "missing" | "explain" | "revisions";
}

const KNOWN_UNITS: readonly UnitType[] = ["SF", "LF", "EA", "CY", "SY", "HR", "LS"];
const normalizeUnit = (unit: string | null): UnitType => {
  const upper = (unit ?? "").trim().toUpperCase();
  return (KNOWN_UNITS as readonly string[]).includes(upper) ? (upper as UnitType) : "EA";
};

const readableError = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : error instanceof Error ? error.message : fallback;

export const FullRegionalEvidence = ({ saved }: { saved: FullTakeoffCheckpoint }) => {
  const evidence = presentFullTakeoffCheckpoint(saved.pass.checkpoint), rectangle = fullRegionRectangle(saved.region?.rectangle);
  return <section aria-label="Selected regional evidence" className="mt-3 rounded border border-blue-200 bg-blue-50 p-3 space-y-2">
    <h5 className="font-semibold">Region {saved.region?.key ?? 'identity unavailable'} — {saved.region?.status ?? 'status unavailable'}</h5>
    {rectangle && <p>Row {rectangle.row}, column {rectangle.column} of {rectangle.rows} × {rectangle.columns} regions. Neighboring regions overlap.</p>}
    <p>This is persisted reading evidence. Verify the source PDF, scale, physical identity and duplicate elements; no measured quantity or price is certified.</p>
    {!saved.pass.checkpoint && <p>No regional checkpoint payload has been saved yet. A processing or unknown state does not imply success.</p>}
    {evidence.observations.map((observation, index) => <div key={index} className="rounded bg-white p-2"><p>{observation.description}</p>
      {observation.sourceExcerpt ? <blockquote className="mt-1 border-l-2 border-slate-300 pl-2">Source excerpt: {observation.sourceExcerpt}</blockquote> : <p className="text-amber-900">No source excerpt saved. Check the actual source region.</p>}
    </div>)}
    {evidence.blockers.length > 0 && <ul className="list-disc pl-4 text-amber-900">{evidence.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul>}
    {saved.pass.checkpoint && !evidence.observations.length && !evidence.blockers.length && <p>No readable observation or blocker is saved in this regional checkpoint.</p>}
  </section>;
};

export const AIPlanModal: React.FC<AIPlanModalProps> = ({
  project,
  workspaceId,
  isOpen,
  canWrite = false,
  onClose,
  onAddQuantityItem,
  initialTab = "analyze",
}) => {
  const [activeTab, setActiveTab] = useState<"analyze" | "missing" | "explain" | "revisions">(
    initialTab
  );
  const [ignoredItems, setIgnoredItems] = useState<Record<string, boolean>>({});
  const [job, setJob] = useState<PlanReadingJob | null>(null);
  const [fullRun, setFullRun] = useState<FullTakeoffRun | null>(null);
  const [runAction, setRunAction] = useState<"cancel" | "restart" | null>(null);
  const [runActionError, setRunActionError] = useState<string | null>(null);
  const [checkpoints, setCheckpoints] = useState<Record<string, FullTakeoffPass>>({});
  const [regionalCheckpoints, setRegionalCheckpoints] = useState<Record<string, FullTakeoffCheckpoint>>({});
  const [selectedRegions, setSelectedRegions] = useState<Record<string, string>>({});
  const [checkpointErrors, setCheckpointErrors] = useState<Record<string, string>>({});
  const [loadingCheckpoints, setLoadingCheckpoints] = useState<Record<string, boolean>>({});
  const [jobError, setJobError] = useState<string | null>(null);
  const [isLoadingJob, setIsLoadingJob] = useState(false);
  const [pendingFindingIds, setPendingFindingIds] = useState<Record<string, boolean>>({});
  const [findingActionError, setFindingActionError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [measurementPage, setMeasurementPage] = useState<number | null>(null);
  const pendingActions = useRef(new Set<string>());
  const runActionInFlight = useRef(false);
  const runActionNeedsRefresh = useRef(false);
  const checkpointRequests = useRef(new Set<string>());
  const reviewContext = useRef('');

  const currentRevision =
    project.revisions.find((r) => r.isCurrent) || project.revisions[0];
  const planLabel = currentRevision
    ? `${currentRevision.fileName} (Rev ${currentRevision.revisionNumber})`
    : "no uploaded plan";
  const jobId = currentRevision?.aiPlanJobId ?? null;
  const isFullRun = currentRevision?.aiPlanMode === "full_v2";
  const contextKey = `${isOpen}:${workspaceId}:${project.id}:${jobId}:${isFullRun}`;
  reviewContext.current = contextKey;
  useEffect(() => { reviewContext.current = contextKey; return () => { reviewContext.current = ''; }; }, [contextKey]);
  useEffect(() => { setMeasurementPage(null); }, [isOpen, workspaceId, jobId, isFullRun]);

  // Poll the real plan-reading job while it's open and still in flight —
  // there is no live-update channel, so short-interval polling is how the
  // estimator sees the worker's progress (queued -> processing -> done).
  useEffect(() => {
    setJob(null);
    setFullRun(null);
    setRunAction(null);
    setRunActionError(null);
    setCheckpoints({});
    setRegionalCheckpoints({}); setSelectedRegions({});
    setCheckpointErrors({});
    setLoadingCheckpoints({});
    setIsLoadingJob(false);
    setFindingActionError(null);
    setPendingFindingIds({});
    if (!isOpen || !workspaceId || !jobId) {
      setJob(null);
      setJobError(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const result = isFullRun ? await getFullTakeoffRun(workspaceId, jobId) : await getAiPlanReading(workspaceId, jobId);
        if (cancelled) return;
        runActionNeedsRefresh.current = false;
        if ("mode" in result && result.mode === "full_v2") setFullRun(result);
        else setJob(result as PlanReadingJob);
        setJobError(null);
        if (isAiPlanInFlight(result.status)) {
          timer = setTimeout(poll, 4000);
        }
      } catch (error) {
        if (!cancelled) {
          setJobError(readableError(error, "Could not load saved plan-reading progress."));
          // A transport interruption never cancels the durable worker or
          // imposes an overall reading deadline. Authentication failures stop.
          if (!(error instanceof ApiError && [401, 403, 404].includes(error.status))) timer = setTimeout(poll, 8000);
        }
      }
    };

    setIsLoadingJob(true);
    poll().finally(() => {
      if (!cancelled) setIsLoadingJob(false);
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isOpen, workspaceId, jobId, isFullRun, reload]);

  if (!isOpen) return null;

  const handleRunAction = async (action: "cancel" | "restart") => {
    if (!canWrite || !workspaceId || !jobId || !fullRun || runActionInFlight.current || runActionNeedsRefresh.current) return;
    const presentation = presentFullTakeoffStatus(fullRun);
    if (action === "cancel" ? !presentation.canCancel : !presentation.canRestart) return;
    runActionInFlight.current = true;
    setRunAction(action);
    setRunActionError(null);
    try {
      const result = action === "cancel" ? await cancelFullTakeoffRun(workspaceId, jobId) : await restartFullTakeoffRun(workspaceId, jobId);
      if (reviewContext.current !== contextKey) return;
      setFullRun(previous => previous ? { ...previous, status: result.status } : previous);
      setReload(value => value + 1);
    } catch (error) {
      if (reviewContext.current === contextKey) {
        runActionNeedsRefresh.current = true;
        setRunActionError(readableError(error, "The requested reading action could not be confirmed. Reload saved progress before trying again."));
      }
    } finally {
      runActionInFlight.current = false;
      if (reviewContext.current === contextKey) setRunAction(null);
    }
  };

  const handleLoadCheckpoint = async (pageNumber: number, passType: string, regionKey?: string) => {
    if (!workspaceId || !jobId) return;
    const key = `${pageNumber}:${passType}${regionKey === undefined ? '' : `:region=${regionKey}`}`;
    const requestKey = `${contextKey}:${key}`;
    if (checkpointRequests.current.has(requestKey)) return;
    checkpointRequests.current.add(requestKey);
    setLoadingCheckpoints(previous => ({ ...previous, [key]: true }));
    setCheckpointErrors(previous => { const next = { ...previous }; delete next[key]; return next; });
    try {
      const result = await getFullTakeoffCheckpoint(workspaceId, jobId, pageNumber, passType, regionKey);
      if (regionKey !== undefined && (result.id !== jobId || result.sheet.physical_page_number !== pageNumber || result.pass.pass_type !== passType || result.region?.key !== regionKey)) throw new Error('The saved regional evidence identity could not be verified.');
      if (reviewContext.current === contextKey) {
        if (regionKey === undefined) setCheckpoints(previous => ({ ...previous, [key]: result.pass }));
        else setRegionalCheckpoints(previous => ({ ...previous, [key]: result }));
      }
    } catch (error) {
      if (reviewContext.current === contextKey) setCheckpointErrors(previous => ({ ...previous, [key]: readableError(error, "Could not load this saved evidence.") }));
    } finally {
      checkpointRequests.current.delete(requestKey);
      if (reviewContext.current === contextKey) setLoadingCheckpoints(previous => { const next = { ...previous }; delete next[key]; return next; });
    }
  };

  const applyFindingStatus = (findingId: string, status: "accepted" | "rejected") => {
    setJob((prev) =>
      prev
        ? { ...prev, plan_reading_findings: prev.plan_reading_findings.map((f) => (f.id === findingId ? { ...f, status } : f)) }
        : prev
    );
  };

  const handleAcceptFinding = async (finding: PlanReadingFinding) => {
    const actionKey = `${contextKey}:${finding.id}`;
    if (!workspaceId || finding.status === 'rejected' || project.quantities.some(item => item.findingId === finding.id) || pendingActions.current.has(actionKey)) return;
    pendingActions.current.add(actionKey);
    setPendingFindingIds((prev) => ({ ...prev, [finding.id]: true }));
    setFindingActionError(null);
    try {
      if (finding.status !== 'accepted') await setPlanReadingFindingStatus(workspaceId, finding.id, "accepted");
      if (reviewContext.current !== contextKey) return;

      const area = (typeof finding.geometry?.area === "string" && finding.geometry.area.trim())
        || (typeof finding.geometry?.room === "string" && finding.geometry.room.trim())
        || (finding.finding_type === "room" && finding.label.trim())
        || "Unknown Area";

      onAddQuantityItem(
        {
          name: finding.label,
          quantity: finding.quantity ?? 0,
          unit: normalizeUnit(finding.unit),
          category: finding.finding_type === "room" ? "Rooms & Areas" : finding.finding_type === "labor" ? "Labor" : "Plan Takeoff",
          findingId: finding.id,
          area,
          ...(finding.page_number === null ? {} : { pageNumber: finding.page_number }),
          ...(finding.source_excerpt === null ? {} : { sourceExcerpt: finding.source_excerpt }),
        }
      );
      applyFindingStatus(finding.id, "accepted");
    } catch (error) {
      if (reviewContext.current !== contextKey) return;
      setFindingActionError(readableError(error, "Could not accept this finding."));
    } finally {
      pendingActions.current.delete(actionKey);
      if (reviewContext.current !== contextKey) return;
      setPendingFindingIds((prev) => {
        const next = { ...prev };
        delete next[finding.id];
        return next;
      });
    }
  };

  const handleRejectFinding = async (finding: PlanReadingFinding) => {
    const actionKey = `${contextKey}:${finding.id}`;
    if (!workspaceId || finding.status !== 'needs_review' || pendingActions.current.has(actionKey)) return;
    pendingActions.current.add(actionKey);
    setPendingFindingIds((prev) => ({ ...prev, [finding.id]: true }));
    setFindingActionError(null);
    try {
      await setPlanReadingFindingStatus(workspaceId, finding.id, "rejected");
      if (reviewContext.current !== contextKey) return;
      applyFindingStatus(finding.id, "rejected");
    } catch (error) {
      if (reviewContext.current !== contextKey) return;
      setFindingActionError(readableError(error, "Could not ignore this finding."));
    } finally {
      pendingActions.current.delete(actionKey);
      if (reviewContext.current !== contextKey) return;
      setPendingFindingIds((prev) => {
        const next = { ...prev };
        delete next[finding.id];
        return next;
      });
    }
  };

  const handleIgnore = (key: string) => {
    setIgnoredItems((prev) => ({ ...prev, [key]: true }));
  };

  const findings = job?.plan_reading_findings ?? [];
  const pageCoverage = summarizeReadingCoverage(job?.output_summary, findings);
  const rawLimitations = (job?.output_summary as { limitations?: unknown } | undefined)?.limitations;
  const limitations = Array.isArray(rawLimitations) ? rawLimitations.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())) : [];
  const priceableFindings = findings.filter((f) => f.quantity !== null && f.quantity > 0 && f.unit && KNOWN_UNITS.includes(f.unit as UnitType));
  const noteFindings = findings.filter((f) => !priceableFindings.includes(f));

  const renderFullRun = (run: FullTakeoffRun) => {
    const presentation = presentFullTakeoffStatus(run);
    const sheets = [...(run.sheets ?? [])].sort((a, b) => a.physical_page_number - b.physical_page_number);
    return (
      <div className="space-y-4">
        <section aria-label="Reading progress" role="status" className="p-3.5 bg-brand-50 border border-blue-200 rounded-lg text-brand-900 space-y-2">
          <h4 className="text-sm font-semibold flex items-center gap-2">
            {isAiPlanInFlight(run.status) && <Loader2 className="w-4 h-4 animate-spin" />}
            {presentation.statusLabel}
          </h4>
          <p>{presentation.notice}</p>
          <p className="font-medium">{presentation.savedProgress}</p>
          {presentation.resumeEstimate && <p>Estimated next processing window: {presentation.resumeEstimate}. This time may change.</p>}
          {isAiPlanInFlight(run.status) && run.progress?.currentPage && <p>
            Current physical sheet: {run.progress.currentPage}{run.progress.currentPass ? ` — ${run.progress.currentPass.replaceAll("_", " ")}` : ""}.
          </p>}
          <p>Saved progress includes work that needs attention. Review the page results below; missing quantities and prices remain pending.</p>
          {run.updated_at && <p className="text-slate-600">Last saved update: {new Date(run.updated_at).toLocaleString()}</p>}
          {canWrite && <div className="flex flex-wrap gap-2 pt-1">
            {presentation.canCancel && <button disabled={Boolean(runAction) || Boolean(runActionError)} onClick={() => handleRunAction("cancel")} className="rounded-md border border-rose-300 bg-white px-3 py-1.5 text-rose-800 disabled:opacity-50">
              {runAction === "cancel" ? "Requesting cancellation…" : "Cancel reading"}
            </button>}
            {presentation.canRestart && <button disabled={Boolean(runAction) || Boolean(runActionError)} onClick={() => handleRunAction("restart")} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 disabled:opacity-50">
              {runAction === "restart" ? "Requesting resume…" : "Resume from saved stages"}
            </button>}
          </div>}
        </section>
        {jobError && <div role="alert" className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-900">
          <p>Saved progress could not be refreshed: {jobError}</p><p>The worker may still be running. Last saved evidence remains below.</p>
          <button className="mt-2 underline" onClick={() => setReload(value => value + 1)}>Reload saved progress</button>
        </div>}
        {(run.processing_error || runActionError) && <div role="alert" className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-800">
          {run.processing_error && <><p>Some work could not finish. Review the saved results and pending pages.</p><details><summary>Processing details</summary>{run.processing_error}</details></>}{runActionError && <p>{runActionError}</p>}
          {runActionError && <button className="mt-2 underline" onClick={() => setReload(value => value + 1)}>Reload saved progress before another action</button>}
        </div>}
        <section aria-label="Takeoff review requirements" className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-900 space-y-1">
          <h4 className="font-semibold">{run.output_summary?.takeoff_v2?.releaseStatus === "review_ready" ? "Evidence ready for human review" : "Release pending evidence and review"}</h4>
          <p>Check scale, measurement sources, page references and missing details before using quantities.</p>
          <p>The budget requires supported quantities, assembly compositions and sourced unit prices. No estimate items are created from these observations.</p>
          {(run.status === "failed" || run.status === "cancelled") && !presentation.canRestart && <p>An uncertain or failed attempt must be reconciled before this run can resume. No provider call is repeated from this screen.</p>}
        </section>
        <section aria-label="Saved evidence by sheet" className="space-y-2">
          <h4 className="font-semibold text-slate-900">Saved evidence by physical sheet and stage</h4>
          {!sheets.length && <p className="text-slate-600">No sheet checkpoints are available yet.</p>}
          {sheets.map(sheet => <details key={sheet.id} className="border border-slate-200 rounded-lg p-3">
            <summary className="cursor-pointer font-semibold text-slate-800">Physical sheet {sheet.physical_page_number} — {sheet.status.replaceAll("_", " ")} ({sheet.passes.length} saved stage records)</summary>
            {sheet.status_reason && <p className="mt-2 text-slate-600">{sheet.status_reason}</p>}
            <button type="button" className="mt-3 rounded border border-blue-300 px-3 py-2 text-blue-800" onClick={() => setMeasurementPage(sheet.physical_page_number)}>Review geometry on this sheet</button>
            <div className="space-y-2 mt-3">{sheet.passes.map(pass => {
              const key = `${sheet.physical_page_number}:${pass.pass_type}`;
              const saved = checkpoints[key];
              const evidence = presentFullTakeoffCheckpoint(saved?.checkpoint);
              const regional = presentFullTakeoffRegions(saved?.checkpoint);
              const selectedKey = selectedRegions[key], regionalCacheKey = `${key}:region=${selectedKey}`;
              return <details key={`${pass.pass_type}:${pass.attempt}`} className="border border-slate-200 rounded-md p-2.5" onToggle={event => {
                if (event.currentTarget.open && !saved) void handleLoadCheckpoint(sheet.physical_page_number, pass.pass_type);
              }}>
                <summary className="cursor-pointer text-slate-800">{pass.pass_type.replaceAll("_", " ")} — {pass.status} (attempt {pass.attempt})</summary>
                {pass.failure_classification && <p className="text-rose-800">Attempt requires review: {pass.failure_classification.replaceAll("_", " ")}</p>}
                {loadingCheckpoints[key] && <p role="status" className="mt-2">Loading saved evidence…</p>}
                {checkpointErrors[key] && <p role="alert" className="mt-2 text-rose-800">{checkpointErrors[key]}</p>}
                {saved && <div className="mt-2 space-y-2">
                  {evidence.observations.map((observation, index) => <div key={index} className="p-2 bg-slate-50 rounded">
                    <p>{observation.description}</p>
                    {observation.sourceExcerpt ? <blockquote className="mt-1 pl-2 border-l-2 border-slate-300 text-slate-600">Source excerpt: {observation.sourceExcerpt}</blockquote> : <p className="text-amber-800">No source excerpt saved for this observation. Verify it on the source sheet.</p>}
                  </div>)}
                  {evidence.blockers.length > 0 && <ul className="list-disc pl-4 text-amber-900">{evidence.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul>}
                  {evidence.scaleStatus && <p>Scale evidence: {evidence.scaleStatus.replaceAll("_", " ")}{evidence.scaleSources.length ? ` — ${evidence.scaleSources.join("; ")}` : ""}.</p>}
                  {!evidence.observations.length && !evidence.blockers.length && !evidence.scaleStatus && <p className="text-slate-600">No readable observation or blocker is saved for this attempt yet.</p>}
                </div>}
                <button className="mt-2 underline text-brand-700 disabled:opacity-50" disabled={Boolean(loadingCheckpoints[key])} onClick={() => handleLoadCheckpoint(sheet.physical_page_number, pass.pass_type)}>Reload saved evidence</button>
                {isFullRegionalPass(pass.pass_type) && regional.regions.length > 0 && <div className="mt-3 rounded border border-slate-200 p-3 space-y-2">
                  <p className="font-semibold">Inspect saved evidence by region</p><p>{regional.progress}. Saved records include blocked regions and do not certify coverage.</p>
                  <label className="block">Region<select aria-label={`Saved region on sheet ${sheet.physical_page_number} for ${pass.pass_type}`} className="ml-2 rounded border p-2" value={selectedKey ?? ''} onChange={event => {
                    const regionKey = event.target.value; setSelectedRegions(previous => ({ ...previous, [key]: regionKey }));
                    if (regionKey && !regionalCheckpoints[`${key}:region=${regionKey}`]) void handleLoadCheckpoint(sheet.physical_page_number, pass.pass_type, regionKey);
                  }}><option value="">Select a saved region</option>{regional.regions.map(region => <option value={region.key} key={region.key}>{region.key} — {region.status}</option>)}</select></label>
                  {selectedKey && <><button type="button" className="underline text-brand-700 disabled:opacity-50" disabled={!!loadingCheckpoints[regionalCacheKey]} onClick={() => handleLoadCheckpoint(sheet.physical_page_number, pass.pass_type, selectedKey)}>Reload selected regional evidence</button>
                    {loadingCheckpoints[regionalCacheKey] && <p role="status">Loading saved regional evidence.</p>}
                    {checkpointErrors[regionalCacheKey] && <p role="alert" className="text-rose-800">{checkpointErrors[regionalCacheKey]}</p>}
                    {regionalCheckpoints[regionalCacheKey] && <FullRegionalEvidence saved={regionalCheckpoints[regionalCacheKey]!} />}
                  </>}
                </div>}
              </details>;
            })}</div>
          </details>)}
        </section>
        {measurementPage !== null && workspaceId && <div className="space-y-2">
          <button type="button" className="underline text-slate-600" onClick={() => setMeasurementPage(null)}>Close measurement review</button>
          <PlanMeasurementPanel key={run.id} workspaceId={workspaceId} runId={run.id} pageNumber={measurementPage} canWrite={canWrite} />
        </div>}
      </div>
    );
  };

  const renderAnalyzeTab = () => {
    if (!workspaceId) {
      return (
        <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-amber-900 text-xs">
          AI plan reading requires a signed-in, synced workspace. Sign in and create a synced project first.
        </div>
      );
    }
    if (!jobId) {
      return (
        <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-600 text-xs">
          No AI plan reading has been started for <strong>{planLabel}</strong> yet. Go to the Plans step, upload a PDF plan, wait
          for it to finish processing, then click <strong>Start AI Plan Reading</strong>.
        </div>
      );
    }
    if (isFullRun && fullRun) return renderFullRun(fullRun);
    if (isLoadingJob && !job && !fullRun) {
      return (
        <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-600 text-xs flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span>Loading the AI plan reading job…</span>
        </div>
      );
    }
    if (jobError) {
      return <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-lg text-rose-700 text-xs"><p>{jobError}</p><button className="mt-2 underline" onClick={() => setReload(value => value + 1)}>Retry loading saved reading</button></div>;
    }
    if (!job) return null;
    if (job.status === "queued" || job.status === "processing") {
      return (
        <div className="p-3.5 bg-brand-50 border border-blue-200 rounded-lg text-brand-900 text-xs flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-brand-500" />
          <span>
            {job.status === "queued" ? "Queued for AI plan reading…" : "Reading the plan…"} This updates automatically.
          </span>
        </div>
      );
    }
    if (job.status === "failed") {
      return (
        <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-lg text-rose-700 text-xs">
          AI plan reading failed{job.processing_error ? `: ${job.processing_error}` : "."} This attempt may remain counted.
          Review the plan manually or contact support before starting another reading.
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="p-3 sm:p-3.5 bg-brand-50 border border-blue-200 rounded-lg text-brand-900">
          <div className="font-semibold text-brand-800 mb-1 flex items-center gap-1.5">
            <FileSearch className="w-4 h-4 text-brand-500" />
            <span>Takeoff review for {planLabel}</span>
          </div>
          <p className="text-xs text-brand-400 leading-relaxed">
            Every item below came from the AI reading of your uploaded plan. Nothing here is final — accept or ignore each one
            before it becomes part of your estimate.
          </p>
        </div>

        {!job.output_summary.takeoff_v2 && (
          <section aria-label="Page evidence coverage" role="status" className="p-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-900 space-y-1">
            <h4 className="text-sm font-semibold">{job.output_summary.page_strategy === 'sheet-v1' ? `Single-page review: physical page ${job.output_summary.physical_page_number}` : 'Partial extraction - complete takeoff not verified'}</h4>
            <p className="text-xs">{INCOMPLETE_TAKEOFF_NOTICE}</p>
            <p className="text-xs font-medium">
              Findings cite {pageCoverage.pagesWithFindings.length}{pageCoverage.totalPages !== null ? ` of ${pageCoverage.totalPages}` : ''} pages.
              {' '}{pageCoverage.pageCountSource === 'pdf_preflight' ? 'Page total verified from the PDF.' : pageCoverage.pageCountSource === 'model_reported' ? 'Total reported by the AI; this older reading has no verified PDF count.' : 'The PDF page total is not available.'}
            </p>
            {!job.output_summary.page_strategy && pageCoverage.pagesWithoutFindings.length > 0 && <p className="text-xs">
              No saved source findings on page(s): {pageCoverage.pagesWithoutFindings.slice(0,40).join(', ')}{pageCoverage.pagesWithoutFindings.length > 40 ? ' (first 40 shown)' : ''}.
              {' '}These pages may be informational or may contain omissions; they have not been certified as reviewed.
            </p>}
            <p className="text-xs">Printed room floor area is not wall drywall area. Check wall lengths, heights, openings and assembly layers separately.</p>
          </section>
        )}

        {limitations.length > 0 && (
          <section aria-label="Reading limitations" className="p-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-900">
            <h4 className="text-xs font-semibold mb-1.5">Reading limits — review the full plan</h4>
            <ul className="list-disc pl-4 space-y-1 text-xs leading-relaxed">{limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>
          </section>
        )}

        {job.output_summary.takeoff_v2 && <TakeoffCoverageDashboard coverage={job.output_summary.takeoff_v2} />}

        {findingActionError && (
          <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-lg text-rose-700 text-xs">{findingActionError}</div>
        )}

        <div>
          <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2.5">
            Quantities & Areas (Requires Your Confirmation)
          </h4>
          {priceableFindings.length === 0 ? (
            <p className="text-xs text-slate-500">No supported quantities were extracted in this review. Check the remaining plan manually.</p>
          ) : (
            <div className="space-y-2.5">
              {priceableFindings.map((finding) => {
                const isPending = Boolean(pendingFindingIds[finding.id]);
                return (
                  <div
                    key={finding.id}
                    className="p-3 sm:p-3.5 border border-slate-200 rounded-lg bg-white hover:border-brand-500 transition flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4"
                  >
                    <div>
                      <div className="font-bold text-slate-900 flex items-center gap-1.5">
                        <span>{finding.label}</span>
                        <span className="text-[9px] font-mono uppercase bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">
                          {finding.finding_type}
                        </span>
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {finding.quantity != null && finding.unit ? (
                          <>
                            Quantity: <strong className="text-slate-900">{finding.quantity.toLocaleString()} {finding.unit}</strong>
                            {" • "}
                          </>
                        ) : null}
                        {finding.source_excerpt ? ` • ${finding.source_excerpt}` : ""}
                        {finding.page_number ? ` (Sheet ${finding.page_number})` : ""}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
                      {finding.status === "accepted" && project.quantities.some(item => item.findingId === finding.id) ? (
                        <span className="flex items-center gap-1 text-xs font-semibold text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded">
                          <Check className="w-3.5 h-3.5" /> Added
                        </span>
                      ) : finding.status === "rejected" ? (
                        <span className="text-xs font-semibold text-slate-400 px-2.5 py-1">Ignored</span>
                      ) : (
                        <>
                          <button
                            onClick={() => handleAcceptFinding(finding)}
                            disabled={isPending}
                            className="px-3 py-1.5 bg-brand-500 hover:bg-brand-700 text-white rounded-md text-xs font-semibold transition flex items-center gap-1 shadow-xs disabled:opacity-50"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            <span>{isPending ? "Adding…" : "Add Item"}</span>
                          </button>
                          {finding.status === 'needs_review' && <button
                            onClick={() => handleRejectFinding(finding)}
                            disabled={isPending}
                            className="px-2.5 py-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md text-xs transition disabled:opacity-50"
                          >
                            Ignore
                          </button>}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {noteFindings.length > 0 && (
          <div>
            <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2.5">
              Other Findings (Measurements, Notes & Risks)
            </h4>
            <div className="space-y-2">
              {noteFindings.map((finding) => (
                <div key={finding.id} className="p-2.5 border border-slate-200 rounded-lg bg-slate-50 text-xs">
                  <span className="font-semibold text-slate-900">{finding.label}</span>
                  {finding.value_text ? <span className="text-slate-600"> — {finding.value_text}</span> : null}
                  <span className="text-slate-400"> ({finding.finding_type})</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-2xs p-2 sm:p-4 select-none animate-in fade-in duration-150">
      <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-4 py-3 sm:px-6 sm:py-4 bg-white border-b border-slate-200 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-2.5">
            <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-brand-500 flex items-center justify-center text-white shrink-0">
              <Sparkles className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            </div>
            <div>
              <div className="text-xs sm:text-sm font-bold text-slate-900 flex items-center gap-1.5 sm:gap-2">
                <span>Results and pending items</span>
                <span className="text-[9px] sm:text-[10px] bg-brand-50 text-brand-500 px-1.5 py-0.5 rounded font-mono font-medium">
                  Advisory
                </span>
              </div>
              <div className="text-[10px] sm:text-xs text-slate-500">
                Plan-reading workflow • User approval required
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-900 rounded-md transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-200 bg-slate-50 px-4 sm:px-6 text-xs font-medium text-slate-500 gap-4 sm:gap-6 overflow-x-auto">
          <button
            onClick={() => setActiveTab("analyze")}
            className={`py-2.5 sm:py-3 flex items-center gap-1.5 transition whitespace-nowrap ${
              activeTab === "analyze"
                ? "text-brand-500 border-b-2 border-brand-500 font-semibold"
                : "hover:text-slate-900"
            }`}
          >
            <FileSearch className="w-4 h-4" />
            <span>Plan Scope Takeoff</span>
          </button>
          <button
            onClick={() => setActiveTab("missing")}
            className={`py-2.5 sm:py-3 flex items-center gap-1.5 transition whitespace-nowrap ${
              activeTab === "missing"
                ? "text-brand-500 border-b-2 border-brand-500 font-semibold"
                : "hover:text-slate-900"
            }`}
          >
            <Layers className="w-4 h-4" />
            <span>Missing Trade Scope</span>
          </button>
          <button
            onClick={() => setActiveTab("explain")}
            className={`py-2.5 sm:py-3 flex items-center gap-1.5 transition whitespace-nowrap ${
              activeTab === "explain"
                ? "text-brand-500 border-b-2 border-brand-500 font-semibold"
                : "hover:text-slate-900"
            }`}
          >
            <HelpCircle className="w-4 h-4" />
            <span>Math & Margin Guide</span>
          </button>
        </div>

        {/* Content Body */}
        <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-4 text-xs">
          {/* TAB 1: Plan Analysis — driven by the real plan_reading_jobs/findings */}
          {activeTab === "analyze" && <p className="rounded-lg bg-amber-50 p-3 text-amber-900">Review quantities and area boundaries against the source page before accepting them.</p>}
          {activeTab === "analyze" && renderAnalyzeTab()}

          {activeTab === "missing" && (
            <div className="space-y-3">
              <h3 className="font-bold">Questions to check against your plan</h3>
              <p>These are general reminders, not findings from your drawing. Enter quantities only after checking the source.</p>
              <ul className="list-disc pl-5 space-y-2">
                <li>Are insulation and moisture protection specified?</li>
                <li>Are painting and finishes included in the scope?</li>
                <li>Are demolition, disposal and temporary works required?</li>
                <li>Have you confirmed supplier prices and installation labor?</li>
              </ul>
            </div>
          )}

          {/* TAB 3: Explanation */}
          {activeTab === "explain" && (
            <div className="space-y-4">
              <div className="p-3 sm:p-4 bg-slate-50 rounded-lg border border-slate-200">
                <h4 className="font-bold text-slate-900 text-sm mb-2">
                  ROUGHbid Financial Formulas
                </h4>
                <div className="space-y-2.5 font-mono text-xs text-slate-600">
                  <div className="p-2 bg-white rounded-md border border-slate-200">
                    <span className="text-brand-500 font-bold">1. Direct Cost</span> = Sum(Material + Labor + Equipment)
                  </div>
                  <div className="p-2 bg-white rounded-md border border-slate-200">
                    <span className="text-brand-500 font-bold">2. Overhead Amount</span> = Direct Cost × (Overhead % / 100)
                  </div>
                  <div className="p-2 bg-white rounded-md border border-slate-200">
                    <span className="text-brand-500 font-bold">3. Cost Before Markup</span> = Direct Cost + Overhead Amount
                  </div>
                  <div className="p-2 bg-white rounded-md border border-slate-200">
                    <span className="text-brand-500 font-bold">4. Markup Amount</span> = Cost Before Markup × (Markup % / 100)
                  </div>
                  <div className="p-2 bg-white rounded-md border border-slate-200">
                    <span className="text-brand-500 font-bold">5. Final Price</span> = Cost Before Markup + Markup Amount
                  </div>
                  <div className="p-2 bg-white rounded-md border border-slate-200">
                    <span className="text-emerald-600 font-bold">6. Margin %</span> = (Markup Amount / Final Price) × 100
                  </div>
                </div>
              </div>

              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-900 leading-relaxed">
                <strong>RoughBid Estimator Principle:</strong> Markup is applied to project cost, while Margin is the portion of final contract revenue retained as gross profit. A 20% Markup on a $13,328 Cost Before Markup generates a $2,665.60 profit, yielding a 16.67% true Gross Margin.
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 sm:px-6 sm:py-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-2">
          <span className="text-[10px] sm:text-[11px] text-slate-500 truncate">
            {isFullRun ? 'Use verified measurements and current source prices.' : 'Additions recalculate financial engine instantly.'}
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 sm:py-2 bg-slate-900 hover:bg-black text-white rounded-md text-xs font-semibold transition shrink-0"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
