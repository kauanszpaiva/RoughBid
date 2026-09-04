import React, { useState } from "react";
import {
  Sparkles,
  X,
  Check,
  Plus,
  AlertTriangle,
  HelpCircle,
  FileSearch,
  Layers,
} from "lucide-react";
import { Project, QuantityItem } from "../types";

interface AIPlanModalProps {
  project: Project;
  isOpen: boolean;
  onClose: () => void;
  onAddQuantityItem: (item: Omit<QuantityItem, "id" | "itemNumber">) => void;
  initialTab?: "analyze" | "missing" | "explain" | "revisions";
}

export const AIPlanModal: React.FC<AIPlanModalProps> = ({
  project,
  isOpen,
  onClose,
  onAddQuantityItem,
  initialTab = "analyze",
}) => {
  const [activeTab, setActiveTab] = useState<"analyze" | "missing" | "explain" | "revisions">(
    initialTab
  );
  const [addedItems, setAddedItems] = useState<Record<string, boolean>>({});
  const [ignoredItems, setIgnoredItems] = useState<Record<string, boolean>>({});

  if (!isOpen) return null;

  const currentRevision =
    project.revisions.find((r) => r.isCurrent) || project.revisions[0];

  const handleAddItem = (
    key: string,
    name: string,
    quantity: number,
    unit: any,
    category: string = "AI Suggested Scope"
  ) => {
    onAddQuantityItem({
      name,
      quantity,
      unit,
      category,
    });
    setAddedItems((prev) => ({ ...prev, [key]: true }));
  };

  const handleIgnore = (key: string) => {
    setIgnoredItems((prev) => ({ ...prev, [key]: true }));
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
                Authoritative financial engine • User approval required
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
          {/* TAB 1: Plan Analysis */}
          {activeTab === "analyze" && (
            <div className="space-y-4">
              <div className="p-3 sm:p-3.5 bg-[#eff6ff] border border-blue-200 rounded-lg text-[#1e3a8a]">
                <div className="font-semibold text-[#1e40af] mb-1 flex items-center gap-1.5">
                  <FileSearch className="w-4 h-4 text-[#2563eb]" />
                  <span>Plan Takeoff Analysis for {currentRevision?.fileName} (Rev {currentRevision?.revisionNumber})</span>
                </div>
                <p className="text-xs text-[#3b82f6] leading-relaxed">
                  Based on architectural drawings, the structural scope includes deck footings, ledger board, joist framing, decking boards, and railing.
                </p>
              </div>

              <div>
                <h4 className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider mb-2.5">
                  Suggested Takeoff Line Items (Requires Your Confirmation)
                </h4>

                <div className="space-y-2.5">
                  {[
                    {
                      id: "sug-1",
                      name: "Exterior Composite Decking Boards",
                      qty: 450,
                      unit: "SF",
                      reason: "Calculated from 14' x 20' gross deck area minus stair penetration",
                      category: "Finishes",
                    },
                    {
                      id: "sug-2",
                      name: "Perimeter Handrail & Balusters System",
                      qty: 68,
                      unit: "LF",
                      reason: "Code-required edge fall protection around deck perimeter",
                      category: "Carpentry",
                    },
                    {
                      id: "sug-3",
                      name: "6x6 Post Base Connectors & Joist Hangers",
                      qty: 1,
                      unit: "LS",
                      reason: "Structural hardware package for ledger and joists",
                      category: "Hardware",
                    },
                  ].map((sug) => {
                    const isAdded = addedItems[sug.id];
                    const isIgnored = ignoredItems[sug.id];
                    if (isIgnored) return null;

                    return (
                      <div
                        key={sug.id}
                        className="p-3 sm:p-3.5 border border-[#e5e7eb] rounded-lg bg-white hover:border-[#2563eb] transition flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4"
                      >
                        <div>
                          <div className="font-bold text-[#111827]">
                            {sug.name}
                          </div>
                          <div className="text-xs text-[#6b7280] mt-0.5">
                            Suggested Quantity: <strong className="text-[#111827]">{sug.qty.toLocaleString()} {sug.unit}</strong> • {sug.reason}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
                          {isAdded ? (
                            <span className="flex items-center gap-1 text-xs font-semibold text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded">
                              <Check className="w-3.5 h-3.5" /> Added
                            </span>
                          ) : (
                            <>
                              <button
                                onClick={() =>
                                  handleAddItem(
                                    sug.id,
                                    sug.name,
                                    sug.qty,
                                    sug.unit,
                                    sug.category
                                  )
                                }
                                className="px-3 py-1.5 bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-md text-xs font-semibold transition flex items-center gap-1 shadow-xs"
                              >
                                <Plus className="w-3.5 h-3.5" />
                                <span>Add Item</span>
                              </button>
                              <button
                                onClick={() => handleIgnore(sug.id)}
                                className="px-2.5 py-1.5 text-[#6b7280] hover:text-[#111827] hover:bg-[#f3f4f6] rounded-md text-xs transition"
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
              </div>
            </div>
          )}

          {/* TAB 2: Missing Items */}
          {activeTab === "missing" && (
            <div className="space-y-4">
              <div className="p-3 sm:p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-amber-900">
                <div className="font-semibold text-amber-900 mb-1 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  <span>Cross-Trade Scope Completeness Check</span>
                </div>
                <p className="text-xs text-amber-700">
                  Reviewing current items in project against industry standard CSI masterformat trade packages.
                </p>
              </div>

              <div className="space-y-2.5">
                {[
                  {
                    id: "m-1",
                    name: "Batt Insulation (R-21)",
                    qty: 1200,
                    unit: "SF",
                    reason: "Often paired with Gypsum Board / Drywall assemblies",
                    category: "Thermal",
                  },
                  {
                    id: "m-2",
                    name: "Interior Primer & Finish Paint",
                    qty: 2400,
                    unit: "SF",
                    reason: "Standard finish trade following Drywall installation",
                    category: "Finishes",
                  },
                  {
                    id: "m-3",
                    name: "Vapor Barrier & Moisture Retarder",
                    qty: 1850,
                    unit: "SF",
                    reason: "Underlayment required prior to Flooring install",
                    category: "Finishes",
                  },
                ].map((item) => {
                  const isAdded = addedItems[item.id];
                  const isIgnored = ignoredItems[item.id];
                  if (isIgnored) return null;

                  return (
                    <div
                      key={item.id}
                      className="p-3 sm:p-3.5 border border-[#e5e7eb] rounded-lg bg-white flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4"
                    >
                      <div>
                        <div className="font-bold text-[#111827]">{item.name}</div>
                        <div className="text-xs text-[#6b7280]">
                          {item.qty.toLocaleString()} {item.unit} • {item.reason}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
                        {isAdded ? (
                          <span className="flex items-center gap-1 text-xs font-semibold text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded">
                            <Check className="w-3.5 h-3.5" /> Added
                          </span>
                        ) : (
                          <>
                            <button
                              onClick={() =>
                                handleAddItem(item.id, item.name, item.qty, item.unit, item.category)
                              }
                              className="px-3 py-1.5 bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-md text-xs font-semibold transition flex items-center gap-1 shadow-xs"
                            >
                              <Plus className="w-3.5 h-3.5" />
                              <span>Add Scope</span>
                            </button>
                            <button
                              onClick={() => handleIgnore(item.id)}
                              className="px-2 py-1.5 text-[#6b7280] hover:text-[#111827] rounded-md text-xs"
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
