import React, { useState } from "react";
import {
  FileText,
  FileSpreadsheet,
  Download,
  Eye,
  CheckCircle2,
  Share2,
  Database,
  AlertTriangle,
  Copy,
  Link2,
} from "lucide-react";
import { Project } from "../types";
import { calculateProjectFinancials, formatCurrency } from "../utils/calculations";
import { exportInternalEstimatePDF, exportClientProposalPDF } from "../utils/pdfExport";
import { exportProjectCSV, exportRoughBidJSON } from "../utils/csvExport";
import { Stepper } from "../components/Stepper";
import { ProjectStep } from "../components/Header";
import { ProposalModal } from "../components/ProposalModal";
import { createClientProposal, type ClientProposalPayload } from "../services/api";

interface ExportPageProps {
  project: Project;
  workspaceId: string | null;
  onSelectStep: (step: ProjectStep) => void;
}

export const ExportPage: React.FC<ExportPageProps> = ({
  project,
  workspaceId,
  onSelectStep,
}) => {
  const [showProposalModal, setShowProposalModal] = useState<boolean>(false);
  const [syncSuccess, setSyncSuccess] = useState<boolean>(false);
  const [shareState, setShareState] = useState<"idle" | "creating" | "ready" | "error">("idle");
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);

  const financials = calculateProjectFinancials(
    project.estimateItems,
    project.overheadPercentage,
    project.markupPercentage
  );
  const hasPlan = project.revisions.length > 0;
  const hasQuantities = project.quantities.length > 0;
  const hasEstimate = project.estimateItems.length > 0;
  const canExport = hasPlan && hasQuantities && hasEstimate;

  const handleExportRoughBidPackage = () => {
    if (!canExport) return;
    exportRoughBidJSON(project);
    setSyncSuccess(true);
    setTimeout(() => setSyncSuccess(false), 4000);
  };

  const proposalPayload = (): ClientProposalPayload => {
    const rows = project.estimateItems.map((item) => {
      const itemWeight = financials.directCost > 0 ? item.directCost / financials.directCost : 0;
      return {
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        price: Number((financials.finalPrice * itemWeight).toFixed(2)),
      };
    });
    return {
      projectName: project.name,
      projectAddress: project.address,
      projectType: project.projectType,
      clientName: project.clientName,
      totalAmount: financials.finalPrice,
      validForDays: 30,
      lineItems: rows,
      terms: [
        "All labor, materials, equipment, insurance, and professional cleanup included unless excluded in writing.",
        "Any additions or structural modifications require a signed change order.",
        "Client acceptance records the proposal status inside RoughBid.",
      ],
    };
  };

  const handleCreateClientLink = async () => {
    if (!canExport) return;
    if (!workspaceId || !project.remoteId) {
      setShareState("error");
      setShareError("Sign in and create/sync this project before sending a live client link.");
      return;
    }
    setShareState("creating");
    setShareError(null);
    try {
      const proposal = await createClientProposal(workspaceId, project.remoteId, {
        title: `${project.name} Proposal`,
        clientName: project.clientName,
        totalAmount: financials.finalPrice,
        publicPayload: proposalPayload(),
        expiresInDays: 30,
      });
      const link = `${window.location.origin}/proposal/${proposal.token}`;
      setShareLink(link);
      setShareState("ready");
      await navigator.clipboard.writeText(link).catch(() => undefined);
    } catch (error) {
      setShareState("error");
      setShareError(error instanceof Error ? error.message : "Could not create a client link.");
    }
  };

  const handleCopyClientLink = async () => {
    if (!shareLink) return;
    await navigator.clipboard.writeText(shareLink).catch(() => {
      setShareError("Copy failed. Select the link and copy it manually.");
    });
  };

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-6xl mx-auto space-y-6 select-none font-sans">
      {/* Title & Subtitle */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-[#111827] tracking-tight">
            Export
          </h2>
          <p className="text-xs text-[#6b7280] mt-0.5">
            Export client proposals, internal audit estimates, CSV raw data, and RoughBid packages.
          </p>
        </div>

        <div className="self-start sm:self-auto flex items-center gap-2 text-xs font-medium text-[#4b5563] bg-white border border-[#e5e7eb] px-3 py-1.5 rounded-lg shadow-xs">
          <span>Project Value:</span>
          <strong className="text-[#2563eb] font-bold font-mono">
            {formatCurrency(financials.finalPrice)}
          </strong>
        </div>
      </div>

      {/* Stepper timeline */}
      <Stepper currentStep="export" onSelectStep={onSelectStep} />

      {!canExport && (
        <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-amber-900 text-xs flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <strong>Needs attention before export.</strong> Add {hasPlan ? "" : "a plan"}, {hasQuantities ? "" : "takeoff quantities"} and {hasEstimate ? "" : "priced estimate lines"} before creating client-ready files.
          </div>
        </div>
      )}

      {/* 4 Export Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-5">
        {/* CARD 1: Client Proposal (PDF) */}
        <div className="bg-white border border-[#e5e7eb] rounded-xl p-6 shadow-xs hover:border-[#2563eb] transition flex flex-col justify-between space-y-4 group">
          <div>
            <div className="w-10 h-10 rounded-lg bg-[#eff6ff] text-[#2563eb] flex items-center justify-center mb-3">
              <FileText className="w-5 h-5" />
            </div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-[#111827]">
                Client Proposal (PDF)
              </h3>
              <span className="text-[10px] font-bold bg-[#eff6ff] text-[#2563eb] px-2 py-0.5 rounded">
                Client Safe
              </span>
            </div>
            <p className="text-xs text-[#6b7280] mt-1.5 leading-relaxed">
              Clean, professional proposal document showing scope descriptions, turnkey prices, terms, and signature lines. Internal margins and direct costs are strictly hidden.
            </p>
          </div>

          <div className="flex items-center gap-2 pt-3 border-t border-[#f3f4f6]">
            <button
              onClick={() => setShowProposalModal(true)}
              disabled={!canExport}
              className="flex-1 py-2 bg-white border border-[#e5e7eb] hover:bg-[#f9fafb] text-[#374151] rounded-md text-xs font-semibold transition flex items-center justify-center gap-1.5"
            >
              <Eye className="w-3.5 h-3.5 text-[#6b7280]" />
              <span>View Proposal</span>
            </button>
            <button
              onClick={() => exportClientProposalPDF(project)}
              disabled={!canExport}
              className="flex-1 py-2 bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-md text-xs font-semibold transition shadow-xs flex items-center justify-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export PDF</span>
            </button>
          </div>
        </div>

        {/* CARD: Client Link */}
        <div className="bg-white border border-[#e5e7eb] rounded-xl p-6 shadow-xs hover:border-[#2563eb] transition flex flex-col justify-between space-y-4 group">
          <div>
            <div className="w-10 h-10 rounded-lg bg-[#eff6ff] text-[#2563eb] flex items-center justify-center mb-3">
              <Link2 className="w-5 h-5" />
            </div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-[#111827]">Send Client Link</h3>
              <span className="text-[10px] font-bold bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded">
                No Client Login
              </span>
            </div>
            <p className="text-xs text-[#6b7280] mt-1.5 leading-relaxed">
              Create a secure client view link. The client can open the proposal and sign acceptance without creating a RoughBid account.
            </p>
          </div>

          {shareLink && (
            <div className="p-2.5 bg-[#f9fafb] border border-[#e5e7eb] rounded-md">
              <p className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider mb-1">Client link</p>
              <div className="flex gap-2">
                <input readOnly value={shareLink} className="flex-1 min-w-0 px-2 py-1.5 bg-white border border-[#e5e7eb] rounded text-[11px] text-[#374151]" />
                <button type="button" onClick={handleCopyClientLink} className="px-2.5 py-1.5 bg-[#111827] text-white rounded text-xs font-semibold flex items-center gap-1">
                  <Copy className="w-3.5 h-3.5" />
                  Copy
                </button>
              </div>
            </div>
          )}
          {shareState === "error" && shareError && <p className="text-xs text-red-600">{shareError}</p>}

          <div className="pt-3 border-t border-[#f3f4f6]">
            <button
              onClick={handleCreateClientLink}
              disabled={!canExport || shareState === "creating"}
              className="w-full py-2 bg-[#2563eb] hover:bg-[#1d4ed8] disabled:opacity-60 text-white rounded-md text-xs font-semibold transition shadow-xs flex items-center justify-center gap-1.5"
            >
              <Share2 className="w-3.5 h-3.5" />
              <span>{shareState === "creating" ? "Creating link..." : "Create client view link"}</span>
            </button>
          </div>
        </div>

        {/* CARD 2: Internal Estimate (PDF) */}
        <div className="bg-white border border-[#e5e7eb] rounded-xl p-6 shadow-xs hover:border-[#2563eb] transition flex flex-col justify-between space-y-4 group">
          <div>
            <div className="w-10 h-10 rounded-lg bg-[#f3f4f6] text-[#374151] flex items-center justify-center mb-3">
              <FileText className="w-5 h-5" />
            </div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-[#111827]">
                Internal Estimate (PDF)
              </h3>
              <span className="text-[10px] font-bold bg-amber-100 text-amber-800 px-2 py-0.5 rounded">
                Internal Only
              </span>
            </div>
            <p className="text-xs text-[#6b7280] mt-1.5 leading-relaxed">
              Complete internal audit documentation detailing material, labor, equipment breakdown, direct costs, overhead percentages, markup calculations, and true gross margin.
            </p>
          </div>

          <div className="pt-3 border-t border-[#f3f4f6]">
            <button
              onClick={() => exportInternalEstimatePDF(project)}
              disabled={!canExport}
              className="w-full py-2 bg-white border border-[#e5e7eb] hover:bg-[#f9fafb] text-[#374151] rounded-md text-xs font-semibold transition flex items-center justify-center gap-1.5 shadow-xs"
            >
              <Download className="w-3.5 h-3.5 text-[#6b7280]" />
              <span>Export Internal Estimate PDF</span>
            </button>
          </div>
        </div>

        {/* CARD 3: Spreadsheet Export (CSV) */}
        <div className="bg-white border border-[#e5e7eb] rounded-xl p-6 shadow-xs hover:border-[#2563eb] transition flex flex-col justify-between space-y-4 group">
          <div>
            <div className="w-10 h-10 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center mb-3">
              <FileSpreadsheet className="w-5 h-5" />
            </div>
            <h3 className="text-sm font-bold text-[#111827]">
              Spreadsheet Export (CSV)
            </h3>
            <p className="text-xs text-[#6b7280] mt-1.5 leading-relaxed">
              Structured raw data export containing line item quantities, unit rates, sub-costs, and calculated overhead for seamless import into Excel, Google Sheets, or ERP tools.
            </p>
          </div>

          <div className="pt-3 border-t border-[#f3f4f6]">
            <button
              onClick={() => exportProjectCSV(project)}
              disabled={!canExport}
              className="w-full py-2 bg-white border border-[#e5e7eb] hover:bg-[#f9fafb] text-[#374151] rounded-md text-xs font-semibold transition flex items-center justify-center gap-1.5 shadow-xs"
            >
              <Download className="w-3.5 h-3.5 text-[#6b7280]" />
              <span>Export CSV Spreadsheet</span>
            </button>
          </div>
        </div>

        {/* CARD 4: RoughBid Package */}
        <div className="bg-white border border-[#e5e7eb] rounded-xl p-6 shadow-xs hover:border-[#2563eb] transition flex flex-col justify-between space-y-4 group">
          <div>
            <div className="w-10 h-10 rounded-lg bg-[#eff6ff] text-[#2563eb] flex items-center justify-center mb-3">
              <Database className="w-5 h-5" />
            </div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-[#111827]">
                RoughBid Package
              </h3>
              <span className="text-[10px] font-bold bg-[#eff6ff] text-[#2563eb] px-2 py-0.5 rounded">
                JSON
              </span>
            </div>
            <p className="text-xs text-[#6b7280] mt-1.5 leading-relaxed">
              Export a structured RoughBid project package for backups, handoff, import workflows, and operational review.
            </p>
          </div>

          <div className="pt-3 border-t border-[#f3f4f6]">
            <button
              onClick={handleExportRoughBidPackage}
              disabled={!canExport}
              className={`w-full py-2 rounded-md text-xs font-semibold transition flex items-center justify-center gap-1.5 shadow-xs ${
                syncSuccess
                  ? "bg-emerald-600 text-white"
                  : "bg-[#2563eb] hover:bg-[#1d4ed8] text-white"
              }`}
            >
              {syncSuccess ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>RoughBid package exported</span>
                </>
              ) : (
                <>
                  <Share2 className="w-3.5 h-3.5" />
                  <span>Export RoughBid JSON</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Interactive Proposal Document Modal */}
      <ProposalModal
        project={project}
        isOpen={showProposalModal}
        onClose={() => setShowProposalModal(false)}
      />
    </div>
  );
};
