import React, { useState, useEffect } from "react";
import {
  Upload,
  History,
  Edit2,
  Download,
  Trash2,
  ArrowRight,
  Sparkles,
} from "lucide-react";
import { Project, PlanRevision } from "../types";
import { BlueprintViewer } from "../components/BlueprintViewer";
import { getCapabilities, getReadingQuote, payForReading, type ReadingQuote, ApiError, beginDocumentUpload, completeDocumentUpload, createAiPlanReading, createDocumentDownloadUrl, createDocumentPreviewObjectUrl, grantWorkspaceAiConsent } from "../services/api";

interface PlansPageProps {
  canWrite?: boolean;
  onAppendRevision: (revision: PlanRevision) => void;
  project: Project;
  workspaceId: string | null;
  onUpdateProject: (updated: Project) => void;
  onContinue: () => void;
  onOpenAIAssistant: () => void;
}

export const PlansPage: React.FC<PlansPageProps> = ({
  canWrite = false,
  onAppendRevision,
  project,
  workspaceId,
  onUpdateProject,
  onContinue,
  onOpenAIAssistant,
}) => {
  const [readingQuote, setReadingQuote] = useState<ReadingQuote | null>(null);
  const [paidReadingAvailable, setPaidReadingAvailable] = useState(false);
  useEffect(() => { let active = true; getCapabilities().then(value => { if (active) setPaidReadingAvailable(value.aiReadingAvailable && value.billing); }).catch(() => undefined); return () => { active = false; }; }, []);
  const [isPaying, setIsPaying] = useState(false);
  const [showRevisionsModal, setShowRevisionsModal] = useState<boolean>(false);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [isStartingAi, setIsStartingAi] = useState<boolean>(false);
  const [needsAiConsent, setNeedsAiConsent] = useState<boolean>(false);
  const [isGrantingAiConsent, setIsGrantingAiConsent] = useState<boolean>(false);
  const [planNotice, setPlanNotice] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [editingFileName, setEditingFileName] = useState<boolean>(false);
  const [newFileName, setNewFileName] = useState<string>("");

  const currentRevision =
    project.revisions.find((r) => r.isCurrent) || project.revisions[project.revisions.length - 1];

  useEffect(() => { setReadingQuote(null); setPlanNotice(null); setNeedsAiConsent(false); }, [workspaceId, project.remoteId, currentRevision?.remoteFileId]);

  useEffect(() => {
    let canceled = false;
    setPreviewError(null);
    if (!currentRevision) {
      setPreviewUrl(null);
      setIsPreviewLoading(false);
      return;
    }
    if (currentRevision.fileUrl && !currentRevision.remoteFileId) {
      setPreviewUrl(currentRevision.fileUrl);
      setIsPreviewLoading(false);
      return;
    }
    if (!workspaceId || !currentRevision.remoteFileId) {
      setPreviewUrl(null);
      setIsPreviewLoading(false);
      setPreviewError("This plan is saved locally only. Upload it to a workspace to preview it here.");
      return;
    }
    let objectUrl: string | null = null;
    setPreviewUrl(null);
    setIsPreviewLoading(true);
    createDocumentPreviewObjectUrl(workspaceId, currentRevision.remoteFileId)
      .then((url) => {
        objectUrl = url;
        if (!canceled) setPreviewUrl(url);
        else URL.revokeObjectURL(url);
      })
      .catch((error) => {
        if (!canceled) setPreviewError(readableApiError(error));
      })
      .finally(() => {
        if (!canceled) setIsPreviewLoading(false);
      });
    return () => {
      canceled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [workspaceId, currentRevision?.id, currentRevision?.fileUrl, currentRevision?.remoteFileId]);
  const handlePay = async () => {
    if (!canWrite) return;
    if (!workspaceId || !project.remoteId || !readingQuote) return;
    setIsPaying(true);
    try { window.location.assign((await payForReading(workspaceId, project.remoteId, readingQuote.id)).url); }
    catch (error) { setPlanNotice(readableApiError(error)); }
    finally { setIsPaying(false); }
  };

  // Handle uploading a new plan revision
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

  const applyNewRevision = (newRev: PlanRevision) => {
    if (!canWrite) return;
    onAppendRevision(newRev);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!canWrite) return;
    const input = e.currentTarget;
    const file = e.target.files?.[0];
    if (!file) return;
    if ((file.type && file.type !== "application/pdf") || !file.name.toLowerCase().endsWith(".pdf")) {
      setPlanNotice("Upload a PDF plan file. Images can be attached later as support files.");
      e.target.value = "";
      return;
    }
    if (!workspaceId || !project.remoteId) {
      setPlanNotice("Wait for the project to finish saving, then upload your PDF.");
      input.value = "";
      return;
    }
    if (file.size > 100 * 1024 * 1024) {
      setPlanNotice("Choose a PDF smaller than 100 MB.");
      input.value = "";
      return;
    }

    setIsUploading(true);
    setPlanNotice(null);
    try {
      const nextRevNum = String(project.revisions.length + 1).padStart(2, "0");
      const canUseBackend = Boolean(workspaceId && project.remoteId);
      let remoteFileId: string | undefined;
      let pageCount = 0;
      let processingStatus: PlanRevision["processingStatus"] = canUseBackend ? "uploading" : undefined;
      let notes = canUseBackend
        ? `Revision ${nextRevNum} uploading to private storage.`
        : `Revision ${nextRevNum} stored locally. Sign in and create a synced project for server AI processing.`;

      if (canUseBackend && workspaceId && project.remoteId) {
        const remote = await beginDocumentUpload(workspaceId, project.remoteId, {
          name: file.name,
          contentType: "application/pdf",
          byteSize: file.size,
        });
        const uploaded = await fetch(remote.upload.url, {
          signal: AbortSignal.timeout(120_000),
          method: remote.upload.method,
          headers: remote.upload.headers,
          body: file,
        });
        if (!uploaded.ok) throw new Error(`Private plan upload failed (${uploaded.status})`);
        const completed = await completeDocumentUpload(workspaceId, remote.file.id);
        remoteFileId = completed.id;
        pageCount = completed.page_count ?? 0;
        processingStatus = completed.processing_status;
        notes = `Revision ${nextRevNum} saved privately. Open the PDF and add your quantities and prices.`;
      }

      const newRev: PlanRevision = {
        id: `rev-${Date.now()}`,
        revisionNumber: nextRevNum,
        fileName: file.name,
        fileSize: `${(file.size / (1024 * 1024)).toFixed(1)} MB`,
        pages: pageCount,
        uploadDate: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
        uploadedBy: "Estimator",
        isCurrent: true,
        notes,
        ...(remoteFileId ? { remoteFileId } : {}),
        ...(processingStatus ? { processingStatus } : {}),
      };

      applyNewRevision(newRev);
      setPlanNotice(notes);
    } catch (error) {
      setPlanNotice(error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "The upload timed out. Check your connection and try again." : readableApiError(error));
    } finally {
      setIsUploading(false);
      input.value = "";
    }
  };

  const handleStartAiReading = async () => {
    if (!canWrite) return;
    if (!workspaceId || !project.remoteId || !currentRevision?.remoteFileId) {
      setPlanNotice("AI reading requires a signed-in workspace, synced project, and server-uploaded PDF.");
      return;
    }
    setIsStartingAi(true);
    setPlanNotice(null);
    setNeedsAiConsent(false);
    try {
      const quote = await getReadingQuote(workspaceId, project.remoteId, currentRevision.remoteFileId, project.projectType);
      setReadingQuote(quote);
      if (!['paid', 'failed', 'complete'].includes(quote.status)) {
        setPlanNotice(quote.status === 'processing' ? 'This reading is already in progress. Check again shortly.' : 'Your price is ready. Pay securely below, then return here and check payment to start. No AI has run.');
        return;
      }
      const job = await createAiPlanReading(workspaceId, project.remoteId, {
        file_id: currentRevision.remoteFileId,
        quote_id: quote.id,
        mode: "quick",
        scope: project.projectType,
      });
      const updatedRevisions = project.revisions.map((revision) =>
        revision.id === currentRevision.id ? { ...revision, aiPlanJobId: job.id, aiPlanStatus: job.status, notes: "AI plan reading complete. Review findings before adding them." } : revision
      );
      onUpdateProject({ ...project, revisions: updatedRevisions });
      setPlanNotice(
        job.status === "failed"
          ? "AI plan reading failed. Open the AI Plan Assistant for details."
          : "AI plan reading complete — findings are ready to review."
      );
      // The read is synchronous now, so results are already there — jump
      // straight to the review modal instead of making the estimator click
      // "AI Plan Assistant" again.
      onOpenAIAssistant();
    } catch (error) {
      if (error instanceof ApiError && [403,409].includes(error.status) && /consent|accept AI|approved/i.test(error.message)) {
        setNeedsAiConsent(true);
        setPlanNotice("This workspace hasn't approved sending plan files to AI yet.");
      } else {
        setPlanNotice(readableApiError(error));
      }
    } finally {
      setIsStartingAi(false);
    }
  };

  const handleGrantAiConsent = async () => {
    if (!canWrite) return;
    if (!workspaceId) return;
    setIsGrantingAiConsent(true);
    try {
      await grantWorkspaceAiConsent(workspaceId);
      setNeedsAiConsent(false);
      setPlanNotice("AI processing approved for this workspace. Click Check payment & start again.");
    } catch (error) {
      setPlanNotice(readableApiError(error));
    } finally {
      setIsGrantingAiConsent(false);
    }
  };

  const handleDownloadOriginal = async () => {
    if (!currentRevision) return;
    if (!workspaceId || !currentRevision.remoteFileId) {
      setPlanNotice("This original file is not saved to your workspace. Upload it again to enable downloads.");
      return;
    }
    try {
      const download = await createDocumentDownloadUrl(workspaceId, currentRevision.remoteFileId);
      window.open(download.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setPlanNotice(readableApiError(error));
    }
  };

  const handleSetCurrentRevision = (revisionId: string) => {
    if (!canWrite) return;
    const updatedRevisions = project.revisions.map((r) => ({
      ...r,
      isCurrent: r.id === revisionId,
    }));
    onUpdateProject({ ...project, revisions: updatedRevisions });
    setShowRevisionsModal(false);
  };

  const handleSaveRename = () => {
    if (!canWrite) return;
    if (!newFileName.trim() || !currentRevision) return;
    const updatedRevisions = project.revisions.map((r) =>
      r.id === currentRevision.id ? { ...r, fileName: newFileName.trim() } : r
    );
    onUpdateProject({ ...project, revisions: updatedRevisions });
    setEditingFileName(false);
  };

  const handleDeletePlan = () => {
    if (!canWrite) return;
    if (confirm("Are you sure you want to remove this plan set from the project?")) {
      onUpdateProject({ ...project, revisions: [] });
    }
  };

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-6xl mx-auto space-y-6 select-none font-sans">
      <section className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950" aria-label="Your project steps">
        <h2 className="font-bold mb-2">From your plan to a proposal</h2>
        <ol className="grid sm:grid-cols-5 gap-2 text-xs">
          {['1. Upload your PDF', '2. Review and mark the plan', '3. Add your quantities', '4. Enter your actual costs', '5. Export your proposal'].map(step => <li key={step}>{step}</li>)}
        </ol>
        <p className="mt-3 text-xs">The manual workflow uses no AI API. Optional AI reading requires availability, workspace approval, and confirmed payment before processing.</p>
      </section>
      {readingQuote && readingQuote.file_id === currentRevision?.remoteFileId && <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-3" aria-label="Project payment">
        <div className="flex flex-wrap justify-between gap-3"><div><h3 className="font-bold">Your plan reading</h3><p className="text-sm text-slate-600">{readingQuote.page_count} pages · {readingQuote.trades.join(', ')}</p></div>
          <strong className="text-xl">{new Intl.NumberFormat('en-US',{style:'currency',currency:readingQuote.currency}).format(readingQuote.amount_cents/100)}</strong></div>
        <p className="text-xs text-slate-600">Includes one completed reading and up to two attempts if processing fails. Changes to the plan or scope need a new price. Membership savings are included when active.</p>
        <p className="text-sm">{readingQuote.status === 'quoted' ? 'Awaiting payment' : readingQuote.status === 'complete' ? 'Reading ready to review' : readingQuote.status === 'processing' ? 'Reading in progress' : readingQuote.status === 'failed' ? 'Reading failed — no substitute quantities were generated' : 'Payment confirmed'}</p>
        <div className="flex gap-3 flex-wrap">
          {readingQuote.status === 'quoted' && <button onClick={handlePay} disabled={!canWrite || isPaying} className="rounded-lg bg-blue-600 text-white px-4 py-2 disabled:opacity-50">{isPaying ? 'Opening checkout…' : 'Pay securely with Stripe'}</button>}
          <button onClick={handleStartAiReading} disabled={!canWrite || isStartingAi} className="rounded-lg border px-4 py-2 disabled:opacity-50">{isStartingAi ? 'Checking / processing…' : 'Check payment & start'}</button>
        </div>
      </section>}
      {/* Title & Subtitle */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-[#111827] tracking-tight">
            Plans
          </h2>
          <p className="text-xs text-[#6b7280] mt-0.5">
            Upload and manage your architectural blueprints and plan revisions.
          </p>
          {planNotice && (
            <p className="text-xs text-[#2563eb] mt-2 max-w-2xl">
              {planNotice}
            </p>
          )}
        </div>

        {/* AI Assistant Quick Trigger */}
        <button
          onClick={onOpenAIAssistant}
          disabled={!canWrite || !currentRevision}
          className="self-start sm:self-auto flex items-center gap-1.5 px-3 py-1.5 bg-[#eff6ff] border border-blue-200 text-[#2563eb] hover:bg-blue-100 rounded-md text-xs font-semibold transition cursor-pointer"
        >
          <Sparkles className="w-3.5 h-3.5 text-[#2563eb]" />
          <span>AI Plan Assistant</span>
        </button>
      </div>

      {/* Main Grid: Blueprint Viewer on Left, Details & Actions on Right */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: Interactive PDF/Plan Canvas */}
        <div className="lg:col-span-2">
          {currentRevision ? (
            <BlueprintViewer
              currentRevision={currentRevision}
              projectName={project.name}
              previewUrl={previewUrl}
              isPreviewLoading={isPreviewLoading}
              previewError={previewError}
              onAnnotationsChange={(annotations) => onUpdateProject({ ...project, revisions: project.revisions.map(revision => revision.id === currentRevision.id ? { ...revision, annotations } : revision) })}
              canWrite={canWrite}
            />
          ) : (
            <div className="h-[520px] bg-white border-2 border-dashed border-[#e5e7eb] rounded-xl flex flex-col items-center justify-center p-8 text-center">
              <Upload className="w-10 h-10 text-[#9ca3af] mb-3" />
              <h3 className="text-sm font-bold text-[#111827]">No plan uploaded</h3>
              <p className="text-xs text-[#6b7280] max-w-sm mt-1 mb-4">
                Upload your architectural blueprints (PDF) to start taking off quantities.
              </p>
              <label className="px-4 py-2 bg-[#2563eb] text-white rounded-md font-semibold text-xs cursor-pointer hover:bg-[#1d4ed8] transition">
                <span>Upload PDF Plan</span>
                <input
                  type="file"
                  accept=".pdf,application/pdf"
                  onChange={handleFileUpload}
                  className="hidden"
                  disabled={!canWrite || isUploading || !workspaceId || !project.remoteId}
                />
              </label>
            </div>
          )}
        </div>

        {/* Right 1 Col: Plan Details and Actions Panel */}
        <div className="space-y-6">
          {/* Plan Details Box */}
          <div className="bg-white border border-[#e5e7eb] rounded-xl p-5 shadow-xs">
            <h3 className="text-xs font-bold text-[#111827] mb-4 uppercase tracking-wider">
              Plan Details
            </h3>

            <div className="space-y-3 text-xs">
              <div className="flex justify-between items-center py-1 border-b border-[#f3f4f6]">
                <span className="text-[#6b7280]">File Name</span>
                {editingFileName ? (
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      value={newFileName}
                      onChange={(e) => setNewFileName(e.target.value)}
                      className="border border-[#e5e7eb] rounded px-1.5 py-0.5 text-xs w-36 font-semibold"
                      autoFocus
                    />
                    <button
                      onClick={handleSaveRename} disabled={!canWrite}
                      className="px-2 py-0.5 bg-[#2563eb] text-white rounded text-[10px] font-bold"
                    >
                      Save
                    </button>
                  </div>
                ) : (
                  <span className="font-semibold text-[#111827] truncate max-w-[170px]" title={currentRevision?.fileName}>
                    {currentRevision?.fileName || "None"}
                  </span>
                )}
              </div>

              <div className="flex justify-between items-center py-1 border-b border-[#f3f4f6]">
                <span className="text-[#6b7280]">Revision</span>
                <span className="font-semibold text-[#111827] flex items-center gap-1">
                  <span>{currentRevision?.revisionNumber || "01"}</span>
                  <span className="w-2 h-2 rounded-full bg-[#2563eb] inline-block" title="Current Active Revision" />
                </span>
              </div>

              <div className="flex justify-between items-center py-1 border-b border-[#f3f4f6]">
                <span className="text-[#6b7280]">Upload Date</span>
                <span className="font-semibold text-[#111827]">
                  {currentRevision?.uploadDate || "N/A"}
                </span>
              </div>

              <div className="flex justify-between items-center py-1 border-b border-[#f3f4f6]">
                <span className="text-[#6b7280]">Uploaded By</span>
                <span className="font-semibold text-[#111827]">
                  {currentRevision?.uploadedBy || "—"}
                </span>
              </div>

              <div className="flex justify-between items-center py-1 border-b border-[#f3f4f6]">
                <span className="text-[#6b7280]">Pages</span>
                <span className="font-semibold text-[#111827]">
                  {currentRevision?.pages || "See PDF viewer"}
                </span>
              </div>

              <div className="flex justify-between items-center py-1">
                <span className="text-[#6b7280]">File Size</span>
                <span className="font-semibold text-[#111827]">
                  {currentRevision?.fileSize || "0 MB"}
                </span>
              </div>

              <div className="flex justify-between items-center py-1 border-t border-[#f3f4f6]">
                <span className="text-[#6b7280]">Processing</span>
                <span className="font-semibold text-[#111827] capitalize">
                  {currentRevision?.processingStatus?.replace("_", " ") || (project.remoteId ? "not uploaded" : "local only")}
                </span>
              </div>
            </div>
          </div>

          {/* Actions Box */}
          <div className="bg-white border border-[#e5e7eb] rounded-xl p-5 shadow-xs space-y-2">
            <h3 className="text-xs font-bold text-[#111827] mb-3 uppercase tracking-wider">
              Actions
            </h3>

            {/* Upload New Revision */}
            <label className="w-full flex items-center justify-between px-3 py-2 bg-[#f9fafb] hover:bg-[#f3f4f6] border border-[#e5e7eb] rounded-lg text-xs font-medium text-[#111827] transition cursor-pointer">
              <div className="flex items-center gap-2">
                <Upload className="w-3.5 h-3.5 text-[#2563eb]" />
                <span>Upload New Revision</span>
              </div>
              <span className="text-[10px] font-mono text-[#6b7280]">
                {isUploading ? "Uploading..." : `Rev ${String(project.revisions.length + 1).padStart(2, "0")}`}
              </span>
              <input
                type="file"
                accept=".pdf,application/pdf"
                onChange={handleFileUpload}
                className="hidden"
                disabled={!canWrite || isUploading || !workspaceId || !project.remoteId}
              />
            </label>

            <button
              onClick={handleStartAiReading}
              disabled={!canWrite || !paidReadingAvailable || !currentRevision?.remoteFileId || currentRevision.processingStatus !== "ready" || isStartingAi}
              className="w-full flex items-center justify-between px-3 py-2 bg-[#eff6ff] hover:bg-blue-100 border border-blue-200 rounded-lg text-xs font-medium text-[#1d4ed8] transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-[#2563eb]" />
                <span>Check price & start</span>
              </div>
              <span className="text-[10px] font-mono text-[#2563eb]">
                {isStartingAi ? "Queueing..." : currentRevision?.aiPlanStatus || "Ready"}
              </span>
            </button>

            {!paidReadingAvailable && <p className="text-xs leading-relaxed text-slate-500 px-1 py-2">AI reading is currently unavailable. You can review your PDF, add quantities and costs, and export your estimate manually.</p>}

            {needsAiConsent && (
              <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-[11px] text-amber-900 space-y-1.5">
                <p>Sending plans to AI for reading requires this workspace's owner to approve it once.</p>
                <button
                  onClick={handleGrantAiConsent}
                  disabled={!canWrite || isGrantingAiConsent}
                  className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded text-[11px] font-semibold transition disabled:opacity-50"
                >
                  {isGrantingAiConsent ? "Approving..." : "Approve AI plan reading"}
                </button>
              </div>
            )}

            {/* View Revisions */}
            <button
              onClick={() => setShowRevisionsModal(true)}
              disabled={project.revisions.length === 0}
              className="w-full flex items-center justify-between px-3 py-2 hover:bg-[#f9fafb] rounded-lg text-xs font-medium text-[#374151] transition"
            >
              <div className="flex items-center gap-2">
                <History className="w-3.5 h-3.5 text-[#6b7280]" />
                <span>View Revisions</span>
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#f3f4f6] text-[#4b5563] font-bold">
                {project.revisions.length}
              </span>
            </button>

            {/* Rename File */}
            <button
              onClick={() => {
                if (!canWrite || !currentRevision) return;
                setNewFileName(currentRevision?.fileName || "");
                setEditingFileName(true);
              }}
              disabled={!canWrite || !currentRevision}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[#f9fafb] rounded-lg text-xs font-medium text-[#374151] transition text-left"
            >
              <Edit2 className="w-3.5 h-3.5 text-[#6b7280]" />
              <span>Rename File</span>
            </button>

            {/* Download Original */}
            <button
              onClick={handleDownloadOriginal}
              disabled={!currentRevision}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[#f9fafb] rounded-lg text-xs font-medium text-[#374151] transition text-left"
            >
              <Download className="w-3.5 h-3.5 text-[#6b7280]" />
              <span>Download Original</span>
            </button>

            {/* Delete Plan */}
            <button
              onClick={handleDeletePlan}
              disabled={!canWrite || !currentRevision}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-rose-50 text-rose-600 rounded-lg text-xs font-medium transition text-left"
            >
              <Trash2 className="w-3.5 h-3.5 text-rose-500" />
              <span>Delete Plan</span>
            </button>
          </div>
        </div>
      </div>

      {/* Bottom Next Step Button */}
      <div className="flex justify-end pt-4 border-t border-[#e5e7eb]">
        <button
          onClick={onContinue}
          className="flex items-center gap-2 px-5 py-2.5 bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-md text-xs font-semibold transition shadow-xs cursor-pointer"
        >
          <span>Continue to Quantities</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Revision History Modal */}
      {showRevisionsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-2xs p-4 select-none">
          <div className="bg-white rounded-xl shadow-xl border border-[#e5e7eb] w-full max-w-lg p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-[#e5e7eb] pb-3">
              <h3 className="text-sm font-bold text-[#111827] flex items-center gap-2">
                <History className="w-4 h-4 text-[#2563eb]" />
                <span>Plan Revision History</span>
              </h3>
              <button
                onClick={() => setShowRevisionsModal(false)}
                className="text-[#9ca3af] hover:text-[#111827]"
              >
                ✕
              </button>
            </div>

            <div className="space-y-2.5">
              {project.revisions.map((rev) => (
                <div
                  key={rev.id}
                  className={`p-3.5 rounded-lg border flex items-center justify-between transition ${
                    rev.isCurrent
                      ? "bg-[#eff6ff] border-blue-200"
                      : "bg-white border-[#e5e7eb] hover:border-slate-300"
                  }`}
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-xs text-[#111827]">
                        Revision {rev.revisionNumber}
                      </span>
                      {rev.isCurrent && (
                        <span className="text-[10px] font-bold bg-[#2563eb] text-white px-2 py-0.5 rounded">
                          CURRENT
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-[#6b7280] mt-0.5">
                      {rev.fileName} • {rev.uploadDate} ({rev.fileSize})
                    </div>
                    {rev.notes && (
                      <p className="text-[11px] text-[#6b7280] italic mt-1">
                        &quot;{rev.notes}&quot;
                      </p>
                    )}
                  </div>

                  {!rev.isCurrent && (
                    <button
                      onClick={() => handleSetCurrentRevision(rev.id)} disabled={!canWrite}
                      className="px-3 py-1.5 border border-[#e5e7eb] rounded text-xs font-medium text-[#374151] hover:bg-[#f3f4f6]"
                    >
                      Make Current
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="pt-2 flex justify-end">
              <button
                onClick={() => setShowRevisionsModal(false)}
                className="px-4 py-2 bg-[#111827] text-white rounded-md text-xs font-semibold"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
