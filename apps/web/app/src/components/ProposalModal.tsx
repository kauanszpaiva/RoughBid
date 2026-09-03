import React from "react";
import { X, Printer, FileDown, ShieldCheck } from "lucide-react";
import { Project } from "../types";
import { calculateProjectFinancials, formatCurrency } from "../utils/calculations";
import { exportClientProposalPDF } from "../utils/pdfExport";

interface ProposalModalProps {
  project: Project;
  isOpen: boolean;
  onClose: () => void;
}

export const ProposalModal: React.FC<ProposalModalProps> = ({
  project,
  isOpen,
  onClose,
}) => {
  if (!isOpen) return null;

  const financials = calculateProjectFinancials(
    project.estimateItems,
    project.overheadPercentage,
    project.markupPercentage
  );

  const currentRevision =
    project.revisions.find((r) => r.isCurrent) || project.revisions[0];

  const handlePrint = () => {
    window.print();
  };

  const handleExportPDF = () => {
    exportClientProposalPDF(project);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-2xs p-2 sm:p-4 select-none animate-in fade-in duration-150">
      <div className="bg-white rounded-xl shadow-xl border border-[#e5e7eb] w-full max-w-3xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Top Control Bar */}
        <div className="px-4 py-3 sm:px-6 sm:py-3.5 bg-white border-b border-[#e5e7eb] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="font-bold text-xs sm:text-sm text-[#111827]">Client Proposal Document</span>
            <span className="hidden sm:inline text-[10px] bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded font-mono font-medium">
              Client-Safe • Internal Costs Hidden
            </span>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2">
            <button
              onClick={handlePrint}
              className="flex items-center gap-1 sm:gap-1.5 px-2.5 py-1 sm:px-3 sm:py-1.5 bg-[#f9fafb] border border-[#e5e7eb] hover:bg-[#f3f4f6] text-[#374151] rounded-md text-xs font-medium transition"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>Print</span>
            </button>
            <button
              onClick={handleExportPDF}
              className="flex items-center gap-1 sm:gap-1.5 px-2.5 py-1 sm:px-3 sm:py-1.5 bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-md text-xs font-semibold transition shadow-xs"
            >
              <FileDown className="w-3.5 h-3.5" />
              <span>Export PDF</span>
            </button>
            <button
              onClick={onClose}
              className="p-1 sm:p-1.5 text-[#9ca3af] hover:text-[#111827] rounded-md transition ml-0.5"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Printable Proposal Document Body */}
        <div className="p-3 sm:p-6 md:p-8 overflow-y-auto flex-1 bg-[#f9fafb] font-sans">
          <div className="bg-white border border-[#e5e7eb] p-4 sm:p-6 md:p-8 shadow-xs rounded-xl max-w-2xl mx-auto space-y-6 text-[#111827]">
            {/* Header Banner */}
            <div className="flex flex-col sm:flex-row items-start sm:items-start justify-between border-b border-[#e5e7eb] pb-4 sm:pb-6 gap-3">
              <div>
                <div className="text-xl font-black text-[#111827] tracking-tight">
                  ROUGH<span className="text-[#2563eb]">bid</span>
                </div>
                <div className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider mt-0.5">
                  General Contracting & Estimating
                </div>
                <div className="text-xs text-[#6b7280] mt-1.5">
                  Prime Bid Contractor Network • License #GC-94021
                </div>
              </div>
              <div className="sm:text-right">
                <div className="text-sm sm:text-base font-bold text-[#2563eb]">
                  CONSTRUCTION PROPOSAL
                </div>
                <div className="text-xs text-[#6b7280] font-mono mt-0.5 sm:mt-1">
                  Date: {new Date().toLocaleDateString()}
                </div>
                <div className="text-xs text-[#6b7280] font-mono">
                  Ref: {currentRevision?.fileName} (Rev {currentRevision?.revisionNumber})
                </div>
              </div>
            </div>

            {/* Project & Client Card */}
            <div className="p-3 sm:p-4 bg-[#f9fafb] rounded-lg border border-[#e5e7eb] grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 text-xs">
              <div>
                <span className="text-[#6b7280] font-bold uppercase text-[10px] block">
                  Project
                </span>
                <strong className="text-[#111827] text-sm">{project.name}</strong>
                <p className="text-[#4b5563] mt-0.5">{project.address}</p>
                <p className="text-[#6b7280] text-[11px] mt-0.5">Type: {project.projectType}</p>
              </div>
              <div>
                <span className="text-[#6b7280] font-bold uppercase text-[10px] block">
                  Prepared For Client
                </span>
                <strong className="text-[#111827] text-sm">{project.clientName}</strong>
                <p className="text-[#4b5563] mt-0.5">Primary Property Owner</p>
                <p className="text-[#6b7280] text-[11px] mt-0.5">Payment Terms: Net 30</p>
              </div>
            </div>

            {/* Client-Safe Scope Table (No internal markups/costs) */}
            <div>
              <h3 className="text-xs font-bold text-[#111827] uppercase tracking-wider mb-2">
                Detailed Scope of Work & Fixed Price Schedule
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left border border-[#e5e7eb] rounded-lg overflow-hidden text-xs min-w-[280px]">
                  <thead className="bg-[#f9fafb] text-[#6b7280] font-bold text-[10px] uppercase border-b border-[#e5e7eb]">
                    <tr>
                      <th className="py-2.5 px-3">#</th>
                      <th className="py-2.5 px-3">Item Description</th>
                      <th className="py-2.5 px-3 text-center">Takeoff Qty</th>
                      <th className="py-2.5 px-3 text-right">Turnkey Price</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#f3f4f6]">
                    {project.estimateItems.map((item, idx) => {
                      const itemWeight =
                        financials.directCost > 0 ? item.directCost / financials.directCost : 0;
                      const clientLinePrice = financials.finalPrice * itemWeight;

                      return (
                        <tr key={item.id} className="hover:bg-[#f9fafb]">
                          <td className="py-2.5 px-3 text-[#9ca3af] font-mono">{idx + 1}</td>
                          <td className="py-2.5 px-3 font-semibold text-[#111827]">
                            {item.name}
                          </td>
                          <td className="py-2.5 px-3 text-center text-[#4b5563]">
                            {item.quantity.toLocaleString()} {item.unit}
                          </td>
                          <td className="py-2.5 px-3 text-right font-bold text-[#111827]">
                            {formatCurrency(clientLinePrice)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Total Investment Summary */}
            <div className="flex justify-end pt-2">
              <div className="w-full sm:w-72 bg-[#eff6ff] border border-blue-200 rounded-lg p-4 text-right">
                <span className="text-[10px] font-bold text-[#2563eb] uppercase tracking-wider block">
                  Total Contract Proposal Price
                </span>
                <div className="text-2xl font-black text-[#2563eb] tracking-tight mt-0.5 font-mono">
                  {formatCurrency(financials.finalPrice)}
                </div>
                <span className="text-[11px] text-[#1d4ed8] block mt-1">
                  Guaranteed Fixed Pricing • Valid for 30 Days
                </span>
              </div>
            </div>

            {/* Proposal Terms */}
            <div className="border-t border-[#e5e7eb] pt-4 text-[11px] text-[#6b7280] space-y-1">
              <div className="flex items-center gap-1.5 font-bold text-[#374151] mb-1">
                <ShieldCheck className="w-3.5 h-3.5 text-[#2563eb]" />
                <span>Scope Clarifications & Inclusions</span>
              </div>
              <p>• All labor, materials, equipment, insurance, and professional cleanup included.</p>
              <p>• Project to be constructed strictly in accordance with Plan Revision {currentRevision?.revisionNumber}.</p>
              <p>• Any additions or structural modifications shall be executed via signed change orders.</p>
            </div>

            {/* Signatures */}
            <div className="border-t border-[#e5e7eb] pt-6 grid grid-cols-1 sm:grid-cols-2 gap-6 sm:gap-8 text-[11px]">
              <div>
                <div className="border-b border-[#d1d5db] pb-6 sm:pb-8" />
                <span className="block mt-1 font-bold text-[#111827]">Authorized Contractor Representative</span>
                <span className="text-[#9ca3af]">ROUGHbid Certified Estimator</span>
              </div>
              <div>
                <div className="border-b border-[#d1d5db] pb-6 sm:pb-8" />
                <span className="block mt-1 font-bold text-[#111827]">Client Acceptance Signature</span>
                <span className="text-[#9ca3af]">Date Signed</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
