import React, { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { Project, PlanRevision } from '../types';
import { ApiError, getPlanAiProviders, getAiPlanReading, completeDocumentUpload, createAiPlanReading, processAiPlanReading, type PlanAiProvider, type AiPlanReadingTrade } from '../services/api';

export function PlanReadingControls({ project, workspaceId, onUpdateProject, isUploading = false, onOpenPlans }: {
  project: Project; workspaceId: string | null; onUpdateProject: (p: Project) => void;
  isUploading?: boolean; onOpenPlans?: () => void;
}) {
  const [isStartingAi, setIsStartingAi] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const latest = useRef({ project, onUpdateProject });
  latest.current = { project, onUpdateProject };
  const [provider, setProvider] = useState<'openrouter' | 'gemini'>('openrouter');
  const [providers, setProviders] = useState<PlanAiProvider[]>([]);
  const [providerError, setProviderError] = useState('');
  const currentRevision =
    project.revisions.find((r) => r.isCurrent) || project.revisions[project.revisions.length - 1];
  const fileSizeMb = Number(currentRevision?.fileSize.match(/([\d.]+)\s*MB/i)?.[1] ?? 0);
  const needsLargeFreeRoute = provider === 'gemini' && fileSizeMb > 12;
  const effectiveProvider = needsLargeFreeRoute ? 'openrouter' : provider;
  const effectiveProviderName = effectiveProvider === 'openrouter' ? 'OpenRouter Free Pool' : 'Gemini';
  const providerConfigured = providers.find(p => p.id === effectiveProvider)?.configured === true;
  useEffect(() => {
    let cancelled = false;
    void getPlanAiProviders().then(data => { if (!cancelled) setProviders(data.providers); }).catch(() => { if (!cancelled) setProviderError('Could not check AI availability. Refresh the page.'); });
    return () => { cancelled = true; };
  }, []);
  const [aiScopeMode, setAiScopeMode] = useState<"all_trades" | "selected_scope">("all_trades");
  const [aiAreaText, setAiAreaText] = useState<string>("");
  const [selectedTrades, setSelectedTrades] = useState<AiPlanReadingTrade[]>(["architectural", "structural", "mep"]);

  const tradeOptions: Array<{ value: AiPlanReadingTrade; label: string }> = [
    { value: "architectural", label: "Architectural" },
    { value: "structural", label: "Structural" },
    { value: "mep", label: "MEP" },
    { value: "electrical", label: "Electrical" },
    { value: "plumbing", label: "Plumbing" },
    { value: "hvac", label: "HVAC" },
    { value: "fire_protection", label: "Fire" },
    { value: "sitework", label: "Sitework" },
    { value: "finishes", label: "Finishes" },
    { value: "general", label: "General" },
  ];

  const readableApiError = (error: unknown) => {
    if (error instanceof ApiError) {
      try {
        const parsed = JSON.parse(error.message);
        return typeof parsed.error === "string" ? parsed.error : error.message;
      } catch {
        return error.message;
      }
    }
    return error instanceof Error ? error.message : "Action failed.";
  };

  const updateRevision = (patch: Partial<PlanRevision>) => {
    const { project: current, onUpdateProject: update } = latest.current;
    update({ ...current, revisions: current.revisions.map(r => r.id === currentRevision?.id ? { ...r, ...patch } : r) });
  };
  const handleStartAiReading = async () => {
    if (!workspaceId || !project.remoteId || !currentRevision?.remoteFileId) {
      setNotice("AI reading requires a signed-in workspace, synced project, and server-uploaded PDF.");
      return;
    }
    const requestedAreas = aiAreaText.split(",").map((area) => area.trim()).filter(Boolean);
    if (aiScopeMode === "selected_scope" && requestedAreas.length === 0) {
      setNotice("Add at least one area, room, sheet, or zone for selected-scope AI reading.");
      return;
    }
    setIsStartingAi(true);
    setNotice(null);
    let startedJob: { id: string; status: PlanRevision["aiPlanStatus"] } | undefined;
    try {
      if (currentRevision.processingStatus !== 'ready') await completeDocumentUpload(workspaceId, currentRevision.remoteFileId);
      const job = await createAiPlanReading(workspaceId, project.remoteId, {
        file_id: currentRevision.remoteFileId,
        provider: effectiveProvider,
        mode: "quick",
        scope: project.projectType,
        scopeMode: aiScopeMode,
        requestedAreas,
        trades: selectedTrades,
      });
      startedJob = job;
      updateRevision({ aiPlanJobId: job.id, aiPlanStatus: job.status });
      const processed = await processAiPlanReading(workspaceId, job.id);
      const readingNotice = processed.status === 'failed'
        ? `${effectiveProviderName} could not read this PDF. Check the coverage limitations below before retrying.`
        : `AI plan reading finished for review. Findings stored: ${processed.findingsStored}. Check page coverage and source evidence below.`;
      updateRevision({ aiPlanJobId: job.id, aiPlanStatus: processed.status, notes: readingNotice });
      setNotice(readingNotice);
    } catch (error) {
      setNotice(readableApiError(error));
      if (startedJob) {
        try {
          const saved = await getAiPlanReading(workspaceId, startedJob.id);
          if (['queued', 'processing', 'needs_review', 'ready', 'failed'].includes(saved.status))
            updateRevision({ aiPlanJobId: saved.id, aiPlanStatus: saved.status as NonNullable<PlanRevision['aiPlanStatus']> });
        } catch { /* Preserve the job reference so results can be refreshed. */ }
      }
    } finally {
      setIsStartingAi(false);
    }
  };

  return <section aria-label="Read uploaded PDF" className="space-y-3">
    {currentRevision?.remoteFileId
      ? <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900"><strong>PDF uploaded:</strong> {currentRevision.fileName} · {currentRevision.pages} pages. {currentRevision.aiPlanJobId ? 'Your saved reading is below. You can run another reading with the selected scope.' : 'Ready for AI reading. Choose the provider and click Read below.'}</p>
      : <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900"><p>{currentRevision ? 'This revision has no saved PDF upload. Complete the upload in Plans to read it.' : 'No PDF is attached to this project yet.'}</p>{onOpenPlans && <button onClick={onOpenPlans} className="mt-2 underline">Go to Plans</button>}</div>}
    {notice && <p role="status" className="text-sm text-slate-700">{notice}</p>}
            <div className="rounded-lg border border-[#e5e7eb] bg-[#f9fafb] p-3 space-y-3">
              <div>
                <div className="text-xs font-bold text-[#111827]">AI Reading Scope</div>
                <p className="mt-0.5 text-[11px] text-[#6b7280]">
                  Read uploaded PDFs with your selected free AI route.
                </p>
              </div>

              <label className="block text-xs font-semibold text-slate-700">AI provider
                <select aria-label="AI provider" value={provider} disabled={isStartingAi} onChange={e => setProvider(e.target.value as 'openrouter' | 'gemini')} className="mt-1 w-full rounded border bg-white p-2">
                  <option value="openrouter">OpenRouter Free Pool — $0 API</option>
                  <option value="gemini">Gemini — Google quota</option>
                </select>
              </label>
            {needsLargeFreeRoute && <p className="rounded-md bg-blue-50 p-2 text-xs text-blue-800">This PDF is larger than Gemini's direct free request size, so RoughBid will run it through OpenRouter Free Pool at $0.</p>}
            <button
              onClick={handleStartAiReading}
              disabled={!workspaceId || !project.remoteId || !currentRevision?.remoteFileId || isStartingAi || isUploading || !providerConfigured}
              className="w-full flex items-center justify-between px-3 py-2 bg-[#eff6ff] hover:bg-blue-100 border border-blue-200 rounded-lg text-xs font-medium text-[#1d4ed8] transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-[#2563eb]" />
                <span>Read with {effectiveProviderName}</span>
              </div>
              <span className="text-[10px] font-mono text-[#2563eb]">
                {isStartingAi ? "Reading..." : currentRevision?.aiPlanStatus?.replaceAll("_", " ") || "Ready"}
              </span>
            </button>
              {!providers.length && !providerError && <p role="status" className="text-xs text-slate-500">Checking AI availability…</p>}
              {providerError && <p role="alert" className="text-xs text-amber-800">{providerError}</p>}
              {providers.length > 0 && !providerConfigured && <p role="status" className="text-xs text-amber-800">{effectiveProviderName} needs to be connected by the workspace owner before testing.</p>}
              <details className="space-y-3">
                <summary className="cursor-pointer text-xs font-semibold text-slate-700">Choose areas and trades</summary>
              <div className="grid grid-cols-2 gap-1 rounded-md bg-white p-1 border border-[#e5e7eb]">
                <button
                  type="button"
                  onClick={() => setAiScopeMode("all_trades")}
                  className={`rounded px-2 py-1.5 text-[11px] font-semibold transition ${aiScopeMode === "all_trades" ? "bg-[#111827] text-white" : "text-[#4b5563] hover:bg-[#f3f4f6]"}`}
                >
                  All areas
                </button>
                <button
                  type="button"
                  onClick={() => setAiScopeMode("selected_scope")}
                  className={`rounded px-2 py-1.5 text-[11px] font-semibold transition ${aiScopeMode === "selected_scope" ? "bg-[#111827] text-white" : "text-[#4b5563] hover:bg-[#f3f4f6]"}`}
                >
                  Pick area
                </button>
              </div>

              {aiScopeMode === "selected_scope" && (
                <label className="block">
                  <span className="text-[11px] font-semibold text-[#374151]">Area, room, sheet, or zone</span>
                  <input
                    value={aiAreaText}
                    onChange={(event) => setAiAreaText(event.target.value)}
                    placeholder="Lobby, bathrooms, A-201, second floor"
                    className="mt-1 w-full rounded-md border border-[#d1d5db] bg-white px-2.5 py-2 text-xs text-[#111827] outline-none focus:border-[#2563eb] focus:ring-2 focus:ring-blue-100"
                  />
                </label>
              )}

              <div>
                <div className="text-[11px] font-semibold text-[#374151] mb-1.5">Trades to inspect</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {tradeOptions.map((trade) => {
                    const checked = selectedTrades.includes(trade.value);
                    return (
                      <label key={trade.value} className={`flex items-center gap-1.5 rounded border px-2 py-1.5 text-[11px] font-medium ${checked ? "border-blue-200 bg-[#eff6ff] text-[#1d4ed8]" : "border-[#e5e7eb] bg-white text-[#4b5563]"}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => {
                            setSelectedTrades((current) => event.target.checked
                              ? Array.from(new Set([...current, trade.value]))
                              : current.filter((item) => item !== trade.value));
                          }}
                          className="h-3 w-3"
                        />
                        <span>{trade.label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              </details>
              <p className="text-[11px] text-[#6b7280]">
                Results include source page, confidence, takeoff notes, risks, and missing evidence for human review.
              </p>
              <p className="text-[11px] text-[#6b7280]">{provider === 'openrouter'
                ? 'OpenRouter Free Pool sends this PDF through Cloudflare text conversion and a rotating free AI route. API price is locked at $0 and paid fallback is blocked. Drawings and scale still need manual review. Provider data policies apply.'
                : 'Gemini sends PDFs up to its direct free request size to Google. Larger PDFs use OpenRouter Free Pool at $0 so testing can continue.'} Only submit plans you are authorized to share.</p>
            </div>



  </section>;
}
