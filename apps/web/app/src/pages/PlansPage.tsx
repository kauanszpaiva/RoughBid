import React, { useState } from "react";
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
import { ApiError, beginDocumentUpload, completeDocumentUpload, createAiPlanReading, createDocumentDownloadUrl } from "../services/api";

interface PlansPageProps {
  project: Project;
  workspaceId: string | null;
  onUpdateProject: (updated: Project) => void;
  onContinue: () => void;
  onOpenAIAssistant: () => void;
}

export const PlansPage: React.FC<PlansPageProps> = ({
  project,
  workspaceId,
  onUpdateProject,
  onContinue,
  onOpenAIAssistant,
}) => {
  const [showRevisionsModal, setShowRevisionsModal] = useState<boolean>(false);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [isStartingAi, setIsStartingAi] = useState<boolean>(false);
  const [planNotice, setPlanNotice] = useState<string | null>(null);
  const [editingFileName, setEditingFileName] = useState<boolean>(false);
  const [newFileName, setNewFileName] = useState<string>("");

  const currentRevision =
    project.revisions.find((r) => r.isCurrent) || project.revisions[project.revisions.length - 1];

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
    const updatedRevisions = project.revisions.map((r) => ({
      ...r,
      isCurrent: false,
    }));

    const updatedProject: Project = {
      ...project,
      revisions: [...updatedRevisions, newRev],
    };

    onUpdateProject(updatedProject);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== "application/pdf" || !file.name.toLowerCase().endsWith(".pdf")) {
      setPlanNotice("Upload a PDF plan file. Images can be attached later as support files.");
      e.target.value = "";
      return;
    }

    setIsUploading(true);
    setPlanNotice(null);
    try {
      const nextRevNum = String(project.revisions.length + 1).padStart(2, "0");
      const canUseBackend = Boolean(workspaceId && project.remoteId);
      let remoteFileId: string | undefined;
      let processingStatus: PlanRevision["processingStatus"] = canUseBackend ? "uploading" : undefined;
      let notes = canUseBackend
        ? `Revision ${nextRevNum} uploading to private storage.`
        : `Revision ${nextRevNum} stored locally. Sign in and create a synced project for server AI processing.`;

      if (canUseBackend && workspaceId && project.remoteId) {
        const remote = await beginDocumentUpload(workspaceId, project.remoteId, {
          name: file.name,
          contentType: file.type,
          byteSize: file.size,
        });
        const uploaded = await fetch(remote.upload.url, {
          method: remote.upload.method,
          headers: remote.upload.headers,
          body: file,
        });
        if (!uploaded.ok) throw new Error(`Private plan upload failed (${uploaded.status})`);
        const completed = await completeDocumentUpload(workspaceId, remote.file.id);
        remoteFileId = completed.id;
        processingStatus = completed.processing_status;
        notes = `Revision ${nextRevNum} uploaded to private storage and queued for PDF page processing.`;
      }

      const newRev: PlanRevision = {
        id: `rev-${Date.now()}`,
        revisionNumber: nextRevNum,
        fileName: file.name,
        fileSize: `${(file.size / (1024 * 1024)).toFixed(1)} MB`,
        pages: 0,
        uploadDate: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
        uploadedBy: "Estimator",
        isCurrent: true,
        notes,
        remoteFileId,
        processingStatus,
      };

      applyNewRevision(newRev);
      setPlanNotice(notes);
    } catch (error) {
      setPlanNotice(readableApiError(error));
    } finally {
      setIsUploading(false);
      e.target.value = "";
    }
  };

  const handleStartAiReading = async () => {
    if (!workspaceId || !project.remoteId || !currentRevision?.remoteFileId) {
      setPlanNotice("AI reading requires a signed-in workspace, synced project, and server-uploaded PDF.");
      return;
    }
    setIsStartingAi(true);
    setPlanNotice(null);
    try {
      const job = await createAiPlanReading(workspaceId, project.remoteId, {
        file_id: currentRevision.remoteFileId,
        mode: "quick",
        scope: project.projectType,
      });
      const updatedRevisions = project.revisions.map((revision) =>
        revision.id === currentRevision.id ? { ...revision, aiPlanJobId: job.id, aiPlanStatus: job.status, notes: "AI plan reading queued. Findings will require estimator review." } : revision
      );
      onUpdateProject({ ...project, revisions: updatedRevisions });
      setPlanNotice("AI plan reading queued. Findings will require estimator review.");
    } catch (error) {
      setPlanNotice(readableApiError(error));
    } finally {
      setIsStartingAi(false);
    }
  };

  const handleDownloadOriginal = async () => {
    if (!currentRevision) return;
    if (!workspaceId || !currentRevision.remoteFileId) {
      alert(`Downloading original plan file: ${currentRevision.fileName}`);
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
    const updatedRevisions = project.revisions.map((r) => ({
      ...r,
      isCurrent: r.id === revisionId,
    }));
    onUpdateProject({ ...project, revisions: updatedRevisions });
    setShowRevisionsModal(false);
  };

  const handleSaveRename = () => {
    if (!newFileName.trim() || !currentRevision) return;
    const updatedRevisions = project.revisions.map((r) =>
      r.id === currentRevision.id ? { ...r, fileName: newFileName.trim() } : r
    );
    onUpdateProject({ ...project, revisions: updatedRevisions });
    setEditingFileName(false);
  };

  const handleDeletePlan = () => {
    if (confirm("Are you sure you want to remove this plan set from the project?")) {
      onUpdateProject({ ...project, revisions: [] });
    }
  };

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-6xl mx-auto space-y-6 select-none font-sans">
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
          disabled={!currentRevision}
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
                      onClick={handleSaveRename}
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
                  {currentRevision?.uploadedBy || project.clientName || "J. Smith"}
                </span>
              </div>

              <div className="flex justify-between items-center py-1 border-b border-[#f3f4f6]">
                <span className="text-[#6b7280]">Pages</span>
                <span className="font-semibold text-[#111827]">
                  {currentRevision?.pages || 0}
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
                disabled={isUploading}
              />
            </label>

            <button
              onClick={handleStartAiReading}
              disabled={!currentRevision?.remoteFileId || currentRevision.processingStatus !== "ready" || isStartingAi}
              className="w-full flex items-center justify-between px-3 py-2 bg-[#eff6ff] hover:bg-blue-100 border border-blue-200 rounded-lg text-xs font-medium text-[#1d4ed8] transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-[#2563eb]" />
                <span>Start AI Plan Reading</span>
              </div>
              <span className="text-[10px] font-mono text-[#2563eb]">
                {isStartingAi ? "Queueing..." : currentRevision?.aiPlanStatus || "Ready"}
              </span>
            </button>

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
                if (!currentRevision) return;
                setNewFileName(currentRevision?.fileName || "");
                setEditingFileName(true);
              }}
              disabled={!currentRevision}
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
              disabled={!currentRevision}
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
                      onClick={() => handleSetCurrentRevision(rev.id)}
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
