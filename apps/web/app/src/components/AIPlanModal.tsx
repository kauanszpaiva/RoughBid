import React, { useEffect, useState } from "react";
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
  setPlanReadingFindingStatus,
  type PlanReadingFinding,
  type PlanReadingJob,
} from "../services/api";

interface AIPlanModalProps {
  project: Project;
  workspaceId: string | null;
  isOpen: boolean;
  onClose: () => void;
  onAddQuantityItem: (
    item: Omit<QuantityItem, "id" | "itemNumber">,
    costOverride?: { materialCost: number; laborCost: number; pricingStatus?: "configured" | "missing_price"; pricingSource?: string }
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

export const AIPlanModal: React.FC<AIPlanModalProps> = ({
  project,
  workspaceId,
  isOpen,
  onClose,
  onAddQuantityItem,
  initialTab = "analyze",
}) => {
  const [activeTab, setActiveTab] = useState<"analyze" | "missing" | "explain" | "revisions">(
    initialTab
  );
  const [ignoredItems, setIgnoredItems] = useState<Record<string, boolean>>({});
  const [job, setJob] = useState<PlanReadingJob | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [isLoadingJob, setIsLoadingJob] = useState(false);
  const [pendingFindingIds, setPendingFindingIds] = useState<Record<string, boolean>>({});
  const [findingActionError, setFindingActionError] = useState<string | null>(null);

  const currentRevision =
    project.revisions.find((r) => r.isCurrent) || project.revisions[0];
  const planLabel = currentRevision
    ? `${currentRevision.fileName} (Rev ${currentRevision.revisionNumber})`
    : "no uploaded plan";
  const jobId = currentRevision?.aiPlanJobId ?? null;

  // Poll the real plan-reading job while it's open and still in flight —
  // there is no live-update channel, so short-interval polling is how the
  // estimator sees the worker's progress (queued -> processing -> done).
  useEffect(() => {
    if (!isOpen || !workspaceId || !jobId) {
      setJob(null);
      setJobError(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const result = await getAiPlanReading(workspaceId, jobId);
        if (cancelled) return;
        setJob(result);
        setJobError(null);
        if (result.status === "queued" || result.status === "processing") {
          timer = setTimeout(poll, 4000);
        }
      } catch (error) {
        if (!cancelled) setJobError(readableError(error, "Could not load the AI plan reading job."));
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
  }, [isOpen, workspaceId, jobId]);

  if (!isOpen) return null;

  const applyFindingStatus = (findingId: string, status: "accepted" | "rejected") => {
    setJob((prev) =>
      prev
        ? { ...prev, plan_reading_findings: prev.plan_reading_findings.map((f) => (f.id === findingId ? { ...f, status } : f)) }
        : prev
    );
  };

  const handleAcceptFinding = async (finding: PlanReadingFinding) => {
    if (!workspaceId) return;
    setPendingFindingIds((prev) => ({ ...prev, [finding.id]: true }));
    setFindingActionError(null);
    try {
      await setPlanReadingFindingStatus(workspaceId, finding.id, "accepted");

      const pricing = (finding.geometry as { pricing?: Array<{ category: "material" | "labor"; cost: number }> })?.pricing;
      let costOverride: { materialCost: number; laborCost: number; pricingStatus?: "configured" | "missing_price"; pricingSource?: string } | undefined;

      if (Array.isArray(pricing) && pricing.length > 0) {
        let mat = 0;
        let lab = 0;
        for (const p of pricing) {
          if (p.category === "material") mat += p.cost || 0;
          if (p.category === "labor") lab += p.cost || 0;
        }
        costOverride = {
          materialCost: Number(mat.toFixed(2)),
          laborCost: Number(lab.toFixed(2)),
          pricingStatus: mat > 0 || lab > 0 ? "configured" : "missing_price",
          pricingSource: "AI Finding Geometry Pricing",
        };
      }

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
          ...(finding.page_number == null ? {} : { pageNumber: finding.page_number }),
          area,
          ...(finding.source_excerpt == null ? {} : { sourceExcerpt: finding.source_excerpt }),
        },
        costOverride
      );
      applyFindingStatus(finding.id, "accepted");
    } catch (error) {
      setFindingActionError(readableError(error, "Could not accept this finding."));
    } finally {
      setPendingFindingIds((prev) => {
        const next = { ...prev };
        delete next[finding.id];
        return next;
      });
    }
  };

  const handleRejectFinding = async (finding: PlanReadingFinding) => {
    if (!workspaceId) return;
    setPendingFindingIds((prev) => ({ ...prev, [finding.id]: true }));
    setFindingActionError(null);
    try {
      await setPlanReadingFindingStatus(workspaceId, finding.id, "rejected");
      applyFindingStatus(finding.id, "rejected");
    } catch (error) {
      setFindingActionError(readableError(error, "Could not ignore this finding."));
    } finally {
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
  const priceableFindings = findings.filter((f) => f.quantity !== null && f.quantity > 0 && f.unit && KNOWN_UNITS.includes(f.unit as UnitType));
  const noteFindings = findings.filter((f) => !priceableFindings.includes(f));

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
        <div className="p-3.5 bg-[#f9fafb] border border-[#e5e7eb] rounded-lg text-[#374151] text-xs">
          No AI plan reading has been started for <strong>{planLabel}</strong> yet. Go to the Plans step, upload a PDF plan, wait
          for it to finish processing, then click <strong>Start AI Plan Reading</strong>.
        </div>
      );
    }
    if (isLoadingJob && !job) {
      return (
        <div className="p-3.5 bg-[#f9fafb] border border-[#e5e7eb] rounded-lg text-[#374151] text-xs flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span>Loading the AI plan reading job…</span>
        </div>
      );
    }
    if (jobError) {
      return <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-lg text-rose-700 text-xs">{jobError}</div>;
    }
    if (!job) return null;
    if (job.status === "queued" || job.status === "processing") {
      return (
        <div className="p-3.5 bg-[#eff6ff] border border-blue-200 rounded-lg text-[#1e3a8a] text-xs flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-[#2563eb]" />
          <span>
            {job.status === "queued" ? "Queued for AI plan reading…" : "Reading the plan…"} This updates automatically.
          </span>
        </div>
      );
    }
    if (job.status === "failed") {
      return (
        <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-lg text-rose-700 text-xs">
          AI plan reading failed{job.processing_error ? `: ${job.processing_error}` : "."} Try starting a new reading from the
          Plans step.
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="p-3 sm:p-3.5 bg-[#eff6ff] border border-blue-200 rounded-lg text-[#1e3a8a]">
          <div className="font-semibold text-[#1e40af] mb-1 flex items-center gap-1.5">
            <FileSearch className="w-4 h-4 text-[#2563eb]" />
            <span>Takeoff review for {planLabel}</span>
          </div>
          <p className="text-xs text-[#3b82f6] leading-relaxed">
            Every item below came from the AI reading of your uploaded plan. Nothing here is final — accept or ignore each one
            before it becomes part of your estimate.
          </p>
        </div>

        {findingActionError && (
          <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-lg text-rose-700 text-xs">{findingActionError}</div>
        )}

        <div>
          <h4 className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider mb-2.5">
            Quantities & Areas (Requires Your Confirmation)
          </h4>
          {priceableFindings.length === 0 ? (
            <p className="text-xs text-[#6b7280]">No materials or labor were identified on this plan.</p>
          ) : (
            <div className="space-y-2.5">
              {priceableFindings.map((finding) => {
                const isPending = Boolean(pendingFindingIds[finding.id]);
                return (
                  <div
                    key={finding.id}
                    className="p-3 sm:p-3.5 border border-[#e5e7eb] rounded-lg bg-white hover:border-[#2563eb] transition flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4"
                  >
                    <div>
                      <div className="font-bold text-[#111827] flex items-center gap-1.5">
                        <span>{finding.label}</span>
                        <span className="text-[9px] font-mono uppercase bg-[#f3f4f6] text-[#6b7280] px-1.5 py-0.5 rounded">
                          {finding.finding_type}
                        </span>
                      </div>
                      <div className="text-xs text-[#6b7280] mt-0.5">
                        {finding.quantity != null && finding.unit ? (
                          <>
                            Quantity: <strong className="text-[#111827]">{finding.quantity.toLocaleString()} {finding.unit}</strong>
                            {" • "}
                          </>
                        ) : null}
                        {finding.source_excerpt ? ` • ${finding.source_excerpt}` : ""}
                        {finding.page_number ? ` (Sheet ${finding.page_number})` : ""}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
                      {finding.status === "accepted" ? (
                        <span className="flex items-center gap-1 text-xs font-semibold text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded">
                          <Check className="w-3.5 h-3.5" /> Added
                        </span>
                      ) : finding.status === "rejected" ? (
                        <span className="text-xs font-semibold text-[#9ca3af] px-2.5 py-1">Ignored</span>
                      ) : (
                        <>
                          <button
                            onClick={() => handleAcceptFinding(finding)}
                            disabled={isPending}
                            className="px-3 py-1.5 bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-md text-xs font-semibold transition flex items-center gap-1 shadow-xs disabled:opacity-50"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            <span>{isPending ? "Adding…" : "Add Item"}</span>
                          </button>
                          <button
                            onClick={() => handleRejectFinding(finding)}
                            disabled={isPending}
                            className="px-2.5 py-1.5 text-[#6b7280] hover:text-[#111827] hover:bg-[#f3f4f6] rounded-md text-xs transition disabled:opacity-50"
                          >
                            Ignore
                          </button>
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
            <h4 className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider mb-2.5">
              Other Findings (Measurements, Notes & Risks)
            </h4>
            <div className="space-y-2">
              {noteFindings.map((finding) => (
                <div key={finding.id} className="p-2.5 border border-[#e5e7eb] rounded-lg bg-[#f9fafb] text-xs">
                  <span className="font-semibold text-[#111827]">{finding.label}</span>
                  {finding.value_text ? <span className="text-[#374151]"> — {finding.value_text}</span> : null}
                  <span className="text-[#9ca3af]"> ({finding.finding_type})</span>
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
      <div className="bg-white rounded-xl shadow-xl border border-[#e5e7eb] w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-4 py-3 sm:px-6 sm:py-4 bg-white border-b border-[#e5e7eb] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-2.5">
            <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-[#2563eb] flex items-center justify-center text-white shrink-0">
              <Sparkles className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            </div>
            <div>
              <div className="text-xs sm:text-sm font-bold text-[#111827] flex items-center gap-1.5 sm:gap-2">
                <span>AI Estimator Assistant</span>
                <span className="text-[9px] sm:text-[10px] bg-[#eff6ff] text-[#2563eb] px-1.5 py-0.5 rounded font-mono font-medium">
                  Advisory
                </span>
              </div>
              <div className="text-[10px] sm:text-xs text-[#6b7280]">
                Plan-reading workflow • User approval required
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-[#9ca3af] hover:text-[#111827] rounded-md transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-[#e5e7eb] bg-[#f9fafb] px-4 sm:px-6 text-xs font-medium text-[#6b7280] gap-4 sm:gap-6 overflow-x-auto">
          <button
            onClick={() => setActiveTab("analyze")}
            className={`py-2.5 sm:py-3 flex items-center gap-1.5 transition whitespace-nowrap ${
              activeTab === "analyze"
                ? "text-[#2563eb] border-b-2 border-[#2563eb] font-semibold"
                : "hover:text-[#111827]"
            }`}
          >
            <FileSearch className="w-4 h-4" />
            <span>Plan Scope Takeoff</span>
          </button>
          <button
            onClick={() => setActiveTab("missing")}
            className={`py-2.5 sm:py-3 flex items-center gap-1.5 transition whitespace-nowrap ${
              activeTab === "missing"
                ? "text-[#2563eb] border-b-2 border-[#2563eb] font-semibold"
                : "hover:text-[#111827]"
            }`}
          >
            <Layers className="w-4 h-4" />
            <span>Missing Trade Scope</span>
          </button>
          <button
            onClick={() => setActiveTab("explain")}
            className={`py-2.5 sm:py-3 flex items-center gap-1.5 transition whitespace-nowrap ${
              activeTab === "explain"
                ? "text-[#2563eb] border-b-2 border-[#2563eb] font-semibold"
                : "hover:text-[#111827]"
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
              <div className="p-3 sm:p-4 bg-[#f9fafb] rounded-lg border border-[#e5e7eb]">
                <h4 className="font-bold text-[#111827] text-sm mb-2">
                  ROUGHbid Financial Formulas
                </h4>
                <div className="space-y-2.5 font-mono text-xs text-[#374151]">
                  <div className="p-2 bg-white rounded-md border border-[#e5e7eb]">
                    <span className="text-[#2563eb] font-bold">1. Direct Cost</span> = Sum(Material + Labor + Equipment)
                  </div>
                  <div className="p-2 bg-white rounded-md border border-[#e5e7eb]">
                    <span className="text-[#2563eb] font-bold">2. Overhead Amount</span> = Direct Cost × (Overhead % / 100)
                  </div>
                  <div className="p-2 bg-white rounded-md border border-[#e5e7eb]">
                    <span className="text-[#2563eb] font-bold">3. Cost Before Markup</span> = Direct Cost + Overhead Amount
                  </div>
                  <div className="p-2 bg-white rounded-md border border-[#e5e7eb]">
                    <span className="text-[#2563eb] font-bold">4. Markup Amount</span> = Cost Before Markup × (Markup % / 100)
                  </div>
                  <div className="p-2 bg-white rounded-md border border-[#e5e7eb]">
                    <span className="text-[#2563eb] font-bold">5. Final Price</span> = Cost Before Markup + Markup Amount
                  </div>
                  <div className="p-2 bg-white rounded-md border border-[#e5e7eb]">
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
        <div className="px-4 py-3 sm:px-6 sm:py-3.5 bg-[#f9fafb] border-t border-[#e5e7eb] flex items-center justify-between gap-2">
          <span className="text-[10px] sm:text-[11px] text-[#6b7280] truncate">
            Additions recalculate financial engine instantly.
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 sm:py-2 bg-[#111827] hover:bg-black text-white rounded-md text-xs font-semibold transition shrink-0"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
