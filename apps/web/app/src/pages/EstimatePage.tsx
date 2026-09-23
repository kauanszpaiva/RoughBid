import React, { useEffect, useState } from "react";
import {
  Plus,
  Edit2,
  Trash2,
  ArrowRight,
  Sparkles,
  Check,
  AlertCircle,
  X,
  SlidersHorizontal,
  Search,
} from "lucide-react";
import { Project, EstimateItem, UnitType } from "../types";
import { createUnpricedEstimateItem, editEstimateLine, validateEstimateInput } from "../utils/manualEstimate";
import { hasUnverifiedAiPrice } from "../utils/aiFindingReview";
import {
  calculateProjectFinancials,
  calculateLineDirectCost,
  formatCurrency,
  formatPercentage,
} from "../utils/calculations";
import { Stepper } from "../components/Stepper";
import { ProjectStep } from "../components/Header";

interface EstimatePageProps {
  project: Project;
  canWrite?: boolean;
  onUpdateProject: (updated: Project) => void;
  onContinue: () => void;
  onSelectStep: (step: ProjectStep) => void;
  onOpenAIAssistant: () => void;
}

export const EstimatePage: React.FC<EstimatePageProps> = ({
  project,
  canWrite = false,
  onUpdateProject,
  onContinue,
  onSelectStep,
  onOpenAIAssistant,
}) => {
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editMaterial, setEditMaterial] = useState<number>(0);
  const [editLabor, setEditLabor] = useState<number>(0);
  const [editEquipment, setEditEquipment] = useState<number>(0);
  const [editName, setEditName] = useState<string>("");
  const [editCsi, setEditCsi] = useState<string>("");
  const [editQty, setEditQty] = useState<number>(0);
  const [editUnit, setEditUnit] = useState<UnitType>("SF");

  const [isAddingLine, setIsAddingLine] = useState<boolean>(false);
  const [newName, setNewName] = useState<string>("");
  const [newCsi, setNewCsi] = useState<string>("");
  const [newQty, setNewQty] = useState<number>(1);
  const [newUnit, setNewUnit] = useState<UnitType>("SF");
  const [newMaterial, setNewMaterial] = useState<number>(0);
  const [newLabor, setNewLabor] = useState<number>(0);
  const [newEquipment, setNewEquipment] = useState<number>(0);
  const [error, setError] = useState("");
  const [rateError, setRateError] = useState("");

  const [showRateModal, setShowRateModal] = useState<boolean>(false);
  const [overheadInput, setOverheadInput] = useState<number>(project.overheadPercentage);
  const [markupInput, setMarkupInput] = useState<number>(project.markupPercentage);

  useEffect(() => { if (!canWrite) { setEditingItemId(null); setIsAddingLine(false); setShowRateModal(false); } }, [canWrite]);

  const units: UnitType[] = ["SF", "LF", "EA", "CY", "SY", "HR", "LS"];
  const unpricedItems = project.estimateItems.filter((item) => hasUnverifiedAiPrice(item) || item.pricingStatus === 'missing_price' || calculateLineDirectCost(item.materialCost, item.laborCost, item.equipmentCost) === 0);
  const missingQuantities = project.quantities.filter((quantity) => !project.estimateItems.some((item) => item.quantityId === quantity.id));

  const handleOpenRates = () => {
    if (!canWrite) return;
    setOverheadInput(project.overheadPercentage);
    setMarkupInput(project.markupPercentage);
    setRateError("");
    setShowRateModal(true);
  };

  const handleRestoreQuantities = () => {
    if (!canWrite) return;
    onUpdateProject({ ...project, estimateItems: [...project.estimateItems, ...missingQuantities.map(createUnpricedEstimateItem)] });
    setSearchQuery("");
  };

  // Financial Engine calculation
  const financials = calculateProjectFinancials(
    project.estimateItems,
    project.overheadPercentage,
    project.markupPercentage
  );

  const filteredItems = project.estimateItems.filter((item) =>
    item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (item.csiCode && item.csiCode.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const handleStartEdit = (item: EstimateItem) => {
    if (!canWrite) return;
    setError("");
    setIsAddingLine(false);
    setEditingItemId(item.id);
    setEditName(item.name);
    setEditCsi(item.csiCode || "");
    setEditQty(item.quantity);
    setEditUnit(item.unit);
    setEditMaterial(item.materialCost);
    setEditLabor(item.laborCost);
    setEditEquipment(item.equipmentCost);
  };

  const handleSaveEdit = (id: string) => {
    if (!canWrite) return;
    try {
      onUpdateProject(editEstimateLine(project, id, {
        name: editName, csiCode: editCsi.trim(), quantity: editQty, unit: editUnit,
        materialCost: editMaterial, laborCost: editLabor, equipmentCost: editEquipment,
      }));
    } catch (error) {
      setError(error instanceof Error ? error.message : "This item could not be updated.");
      return;
    }
    setEditingItemId(null);
    setError("");
  };

  const handleDeleteItem = (id: string) => {
    if (!canWrite) return;
    const updatedItems = project.estimateItems.filter((item) => item.id !== id);
    onUpdateProject({ ...project, estimateItems: updatedItems });
  };

  const handleSaveFinancialRates = () => {
    if (!canWrite) return;
    if (![overheadInput, markupInput].every((rate) => Number.isFinite(rate) && rate >= 0 && rate <= 100)) {
      setRateError("Enter percentages from 0 to 100.");
      return;
    }
    onUpdateProject({
      ...project,
      overheadPercentage: Math.max(0, Number(overheadInput) || 0),
      markupPercentage: Math.max(0, Number(markupInput) || 0),
    });
    setShowRateModal(false);
  };

  const handleAddNewItem = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite) return;
    const validationError = validateEstimateInput(newName, newQty, [newMaterial, newLabor, newEquipment]);
    if (validationError) {
      setError(validationError);
      return;
    }

    const materialCost = Number(newMaterial.toFixed(2));
    const laborCost = Number(newLabor.toFixed(2));
    const equipmentCost = Number(newEquipment.toFixed(2));
    const directCost = calculateLineDirectCost(materialCost, laborCost, equipmentCost);
    const newItem: EstimateItem = {
      id: `est-${crypto.randomUUID()}`,
      csiCode: newCsi.trim(),
      name: newName.trim(),
      quantity: Number(newQty) || 0,
      unit: newUnit,
      materialCost,
      laborCost,
      equipmentCost,
      directCost,
    };

    onUpdateProject({
      ...project,
      estimateItems: [...project.estimateItems, newItem],
    });

    setNewName("");
    setNewCsi("");
    setNewQty(1);
    setNewMaterial(0);
    setNewLabor(0);
    setNewEquipment(0);
    setSearchQuery("");
    setError("");
    setIsAddingLine(false);
  };

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-6xl mx-auto space-y-6 font-sans [&_button:disabled]:cursor-not-allowed [&_button:disabled]:opacity-40">
      {/* Title Bar and Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3.5">
        <div>
          <h3 className="text-sm font-bold text-slate-600 uppercase tracking-wider mb-0.5">
            Estimate Table
          </h3>
          <p className="text-xs sm:text-sm text-slate-500">
            Enter your actual material, labor and equipment costs.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <button
            onClick={onOpenAIAssistant}
            className="flex items-center gap-1.5 px-3 py-1.5 sm:px-3.5 sm:py-2 bg-brand-50 border border-brand-200 text-brand-500 hover:bg-brand-100 rounded-md text-xs font-semibold transition cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5 text-brand-500" />
            <span>Estimate Help</span>
          </button>
          <button
            disabled={!canWrite}
            onClick={handleOpenRates}
            className="flex items-center gap-1.5 px-3 py-1.5 sm:px-3.5 sm:py-2 bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 rounded-md text-xs font-semibold transition cursor-pointer"
          >
            <SlidersHorizontal className="w-3.5 h-3.5 text-slate-500" />
            <span>Rates</span>
          </button>
          <button
            disabled={!canWrite}
            onClick={() => { if (!canWrite) return; setIsAddingLine(true); setEditingItemId(null); setError(""); setSearchQuery(""); }}
            className="bg-brand-500 text-white px-3.5 py-1.5 sm:px-4 sm:py-2 rounded-md text-xs sm:text-sm font-semibold flex items-center gap-1.5 sm:gap-2 hover:bg-brand-700 shadow-xs transition cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            <span>Add Item</span>
          </button>
        </div>
      </div>

      {/* Stepper timeline */}
      <Stepper currentStep="estimate" onSelectStep={(step) => { if (editingItemId || isAddingLine) { setError("Save or cancel your open item before changing steps."); return; } onSelectStep(step); }} />

      <div className="rounded-xl border border-blue-100 bg-blue-50/60 px-4 py-3 text-xs leading-relaxed text-blue-900">
        Costs below are <strong>totals for the entire line in USD</strong>, not prices per unit.
        When editing a quantity here, review and enter the matching cost totals.
      </div>
      {error && <div role="alert" className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700"><AlertCircle className="h-4 w-4 shrink-0" />{error}</div>}
      {unpricedItems.length > 0 && <div role="status" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900"><AlertCircle className="h-4 w-4 shrink-0" /><span>{unpricedItems.length} item{unpricedItems.length === 1 ? " needs" : "s need"} verified costs. Historical AI amounts are unverified. Review and save actual costs or remove these items before exporting.</span></div>}
      {missingQuantities.length > 0 && <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl border border-gray-200 bg-white p-3 text-xs text-gray-600"><span>{missingQuantities.length} takeoff item{missingQuantities.length === 1 ? " is" : "s are"} excluded from this estimate.</span><button disabled={!canWrite} onClick={handleRestoreQuantities} className="self-start rounded-md bg-blue-50 px-3 py-2 font-semibold text-blue-700 hover:bg-blue-100">Add missing takeoff items</button></div>}

      {/* Inline Search Bar */}
      {(project.estimateItems.length > 4 || searchQuery) && (
        <div className="relative max-w-sm">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
          <input
            type="text"
            aria-label="Search estimate items"
            disabled={Boolean(editingItemId) || isAddingLine}
            placeholder="Search estimate items or CSI codes..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 bg-white border border-slate-200 rounded-md text-xs text-slate-900 placeholder:text-slate-400 focus:outline-hidden focus:border-brand-500"
          />
        </div>
      )}

      {/* Desktop Estimate Table (hidden on mobile) */}
      <div className="hidden lg:block bg-white border border-slate-200 rounded-xl shadow-xs overflow-x-auto">
        <table className="w-full min-w-[900px] text-left border-collapse">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-bold text-slate-500 uppercase tracking-wider">
              <th className="py-3.5 px-5 font-bold">Item Name</th>
              <th className="py-3.5 px-4 font-bold text-right w-24">Qty</th>
              <th className="py-3.5 px-4 font-bold text-center w-20">Unit</th>
              <th className="py-3.5 px-4 font-bold text-right w-28">Material $</th>
              <th className="py-3.5 px-4 font-bold text-right w-28">Labor $</th>
              <th className="py-3.5 px-4 font-bold text-right w-28">Equip $</th>
              <th className="py-3.5 px-5 font-bold text-right bg-slate-100 text-slate-900 w-32">
                Direct Cost
              </th>
              <th className="py-3.5 px-4 font-bold text-right w-20">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 text-sm text-slate-900">
            {filteredItems.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-12 text-center text-slate-400 text-sm">
                  No line items found. Click &quot;Add Item&quot; to add your first takeoff cost item.
                </td>
              </tr>
            ) : (
              filteredItems.map((item) => {
                const isEditing = editingItemId === item.id;

                return (
                  <tr
                    key={item.id}
                    className="hover:bg-slate-50 transition-colors group"
                  >
                    {/* Item Name & CSI */}
                    <td className="py-3.5 px-5 font-medium">
                      {isEditing ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            aria-label="CSI code"
                            value={editCsi}
                            onChange={(e) => setEditCsi(e.target.value)}
                            placeholder="CSI Code"
                            className="w-20 px-2 py-1 border border-brand-500 rounded text-xs font-mono"
                          />
                          <input
                            type="text"
                            aria-label="Item description"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="flex-1 px-2 py-1 border border-brand-500 rounded text-xs font-semibold"
                          />
                        </div>
                      ) : (
                        <div>
                          <span
                            onClick={() => handleStartEdit(item)}
                            className="cursor-pointer hover:text-brand-500 transition font-semibold"
                          >
                            {item.name}
                          </span>
                          {item.csiCode && (
                            <span className="ml-2 text-[10px] text-slate-500 font-mono bg-slate-100 px-1.5 py-0.5 rounded">
                              {item.csiCode}
                            </span>
                          )}
                        </div>
                      )}
                    </td>

                    {/* Quantity */}
                    <td className="py-3.5 px-4 text-right font-mono">
                      {isEditing ? (
                        <input
                          type="number"
                          min="0"
                          step="any"
                          aria-label="Quantity"
                          value={editQty}
                          onChange={(e) => setEditQty(Number(e.target.value))}
                          className="w-20 px-1.5 py-1 border border-brand-500 rounded text-xs text-right font-mono"
                        />
                      ) : (
                        item.quantity.toLocaleString()
                      )}
                    </td>

                    {/* Unit */}
                    <td className="py-3.5 px-4 text-center">
                      {isEditing ? (
                        <select
                          aria-label="Unit"
                          value={editUnit}
                          onChange={(e) => setEditUnit(e.target.value as UnitType)}
                          className="px-1.5 py-1 border border-brand-500 rounded text-xs bg-white"
                        >
                          {units.map((u) => (
                            <option key={u} value={u}>
                              {u}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-slate-500 text-xs font-semibold">
                          {item.unit}
                        </span>
                      )}
                    </td>

                    {/* Material Cost */}
                    <td className="py-3.5 px-4 text-right font-mono text-slate-600">
                      {isEditing ? (
                        <input
                          type="number"
                          min="0"
                          step="any"
                          aria-label="Material total in USD"
                          value={editMaterial}
                          onChange={(e) => setEditMaterial(Number(e.target.value))}
                          className="w-20 px-1.5 py-1 border border-brand-500 rounded text-xs text-right font-mono"
                        />
                      ) : (
                        formatCurrency(item.materialCost)
                      )}
                    </td>

                    {/* Labor Cost */}
                    <td className="py-3.5 px-4 text-right font-mono text-slate-600">
                      {isEditing ? (
                        <input
                          type="number"
                          min="0"
                          step="any"
                          aria-label="Labor total in USD"
                          value={editLabor}
                          onChange={(e) => setEditLabor(Number(e.target.value))}
                          className="w-20 px-1.5 py-1 border border-brand-500 rounded text-xs text-right font-mono"
                        />
                      ) : (
                        formatCurrency(item.laborCost)
                      )}
                    </td>

                    {/* Equipment Cost */}
                    <td className="py-3.5 px-4 text-right font-mono text-slate-600">
                      {isEditing ? (
                        <input
                          type="number"
                          min="0"
                          step="any"
                          aria-label="Equipment total in USD"
                          value={editEquipment}
                          onChange={(e) => setEditEquipment(Number(e.target.value))}
                          className="w-20 px-1.5 py-1 border border-brand-500 rounded text-xs text-right font-mono"
                        />
                      ) : (
                        formatCurrency(item.equipmentCost)
                      )}
                    </td>

                    {/* Direct Cost (Highlighted column) */}
                    <td className="py-3.5 px-5 text-right font-mono font-bold bg-slate-100 text-slate-900">
                      {formatCurrency(isEditing ? calculateLineDirectCost(editMaterial, editLabor, editEquipment) : calculateLineDirectCost(item.materialCost, item.laborCost, item.equipmentCost))}
                    </td>

                    {/* Actions */}
                    <td className="py-3.5 px-4 text-right">
                      {isEditing ? (
                        <div className="flex items-center justify-end gap-1">
                          <button
                            disabled={!canWrite}
                            onClick={() => handleSaveEdit(item.id)}
                            className="p-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded transition"
                            title="Save item"
                            aria-label="Save item"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => { setEditingItemId(null); setError(""); }} className="p-1 text-gray-500 hover:text-gray-900" title="Cancel edit" aria-label="Cancel edit"><X className="w-3.5 h-3.5" /></button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-end gap-1 text-slate-400">
                          <button
                            disabled={!canWrite}
                            onClick={() => handleStartEdit(item)}
                            className="p-1 hover:text-brand-500 transition"
                            title="Edit"
                            aria-label="Edit item"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            disabled={!canWrite}
                            onClick={() => handleDeleteItem(item.id)}
                            className="p-1 hover:text-red-600 transition"
                            title="Delete"
                            aria-label="Delete item"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        {/* Add Item Row Form if open */}
        {isAddingLine && (
          <form
            onSubmit={handleAddNewItem}
            className="p-4 bg-brand-50/60 border-t border-brand-200 grid grid-cols-12 gap-3 items-center text-xs"
          >
            <div className="col-span-2">
              <input
                type="text"
                placeholder="CSI (09 29 00)"
                aria-label="New CSI code"
                value={newCsi}
                onChange={(e) => setNewCsi(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded text-xs font-mono"
              />
            </div>
            <div className="col-span-3">
              <input
                type="text"
                placeholder="Item name (e.g., Drywall 5/8 Type X)"
                aria-label="New item description"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded text-xs font-semibold"
                required
              />
            </div>
            <div className="col-span-1">
              <input
                type="number"
                min="0"
                step="any"
                aria-label="New quantity"
                value={newQty}
                onChange={(e) => setNewQty(Number(e.target.value))}
                className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded text-xs text-right font-mono"
                placeholder="Qty"
              />
            </div>
            <div className="col-span-1">
              <select
                aria-label="New unit"
                value={newUnit}
                onChange={(e) => setNewUnit(e.target.value as UnitType)}
                className="w-full px-1 py-1.5 bg-white border border-slate-300 rounded text-xs"
              >
                {units.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-span-1">
              <input
                type="number"
                min="0"
                step="any"
                aria-label="New material total in USD"
                value={newMaterial}
                onChange={(e) => setNewMaterial(Number(e.target.value))}
                className="w-full px-1.5 py-1.5 bg-white border border-slate-300 rounded text-xs text-right font-mono"
                placeholder="Mat $"
              />
            </div>
            <div className="col-span-1">
              <input
                type="number"
                min="0"
                step="any"
                aria-label="New labor total in USD"
                value={newLabor}
                onChange={(e) => setNewLabor(Number(e.target.value))}
                className="w-full px-1.5 py-1.5 bg-white border border-slate-300 rounded text-xs text-right font-mono"
                placeholder="Labor $"
              />
            </div>
            <div className="col-span-1">
              <input
                type="number"
                min="0"
                step="any"
                aria-label="New equipment total in USD"
                value={newEquipment}
                onChange={(e) => setNewEquipment(Number(e.target.value))}
                className="w-full px-1.5 py-1.5 bg-white border border-slate-300 rounded text-xs text-right font-mono"
                placeholder="Equip $"
              />
            </div>
            <div className="col-span-2 flex items-center justify-end gap-2">
              <button
                type="submit"
                className="px-3 py-1.5 bg-brand-500 hover:bg-brand-700 text-white rounded text-xs font-semibold shadow-xs"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => setIsAddingLine(false)}
                className="px-2.5 py-1.5 text-slate-500 hover:text-slate-900 text-xs"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Mobile Stacked Line Item Cards (visible on mobile only) */}
      <div className="lg:hidden space-y-3">
        {filteredItems.length === 0 ? (
          <div className="bg-white border border-dashed border-slate-200 rounded-xl p-8 text-center text-slate-400 text-xs">
            No line items found. Tap &quot;Add Item&quot; to begin estimating.
          </div>
        ) : (
          filteredItems.map((item) => {
            const isEditing = editingItemId === item.id;

            if (isEditing) {
              return (
                <div
                  key={item.id}
                  className="bg-white border-2 border-brand-500 rounded-xl p-4 shadow-sm space-y-3"
                >
                  <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                    <span className="text-xs font-bold text-brand-500">
                      Edit Estimate Item
                    </span>
                    <button
                      onClick={() => setEditingItemId(null)}
                      className="text-xs text-slate-500 hover:text-slate-900"
                    >
                      Cancel
                    </button>
                  </div>

                  <div className="space-y-2 text-xs">
                    <div>
                      <label className="text-[10px] font-bold text-slate-500 uppercase block mb-1">
                        Item Name
                      </label>
                      <input
                        type="text"
                        aria-label="Item description"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="w-full px-3 py-1.5 border border-slate-200 rounded-md font-semibold"
                      />
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      <div className="col-span-1">
                        <label className="text-[10px] font-bold text-slate-500 uppercase block mb-1">
                          CSI
                        </label>
                        <input
                          type="text"
                          aria-label="CSI code"
                          value={editCsi}
                          onChange={(e) => setEditCsi(e.target.value)}
                          className="w-full px-2 py-1.5 border border-slate-200 rounded-md font-mono"
                        />
                      </div>
                      <div className="col-span-1">
                        <label className="text-[10px] font-bold text-slate-500 uppercase block mb-1">
                          Qty
                        </label>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          aria-label="Quantity"
                          value={editQty}
                          onChange={(e) => setEditQty(Number(e.target.value))}
                          className="w-full px-2 py-1.5 border border-slate-200 rounded-md font-mono font-bold text-right"
                        />
                      </div>
                      <div className="col-span-1">
                        <label className="text-[10px] font-bold text-slate-500 uppercase block mb-1">
                          Unit
                        </label>
                        <select
                          aria-label="Unit"
                          value={editUnit}
                          onChange={(e) => setEditUnit(e.target.value as UnitType)}
                          className="w-full px-2 py-1.5 border border-slate-200 rounded-md bg-white font-semibold"
                        >
                          {units.map((u) => (
                            <option key={u} value={u}>
                              {u}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2 pt-1">
                      <div>
                        <label className="text-[10px] font-bold text-slate-500 uppercase block mb-1">
                          Mat ($)
                        </label>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          aria-label="Material total in USD"
                          value={editMaterial}
                          onChange={(e) => setEditMaterial(Number(e.target.value))}
                          className="w-full px-2 py-1.5 border border-slate-200 rounded-md font-mono text-right"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-bold text-slate-500 uppercase block mb-1">
                          Labor ($)
                        </label>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          aria-label="Labor total in USD"
                          value={editLabor}
                          onChange={(e) => setEditLabor(Number(e.target.value))}
                          className="w-full px-2 py-1.5 border border-slate-200 rounded-md font-mono text-right"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-bold text-slate-500 uppercase block mb-1">
                          Equip ($)
                        </label>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          aria-label="Equipment total in USD"
                          value={editEquipment}
                          onChange={(e) => setEditEquipment(Number(e.target.value))}
                          className="w-full px-2 py-1.5 border border-slate-200 rounded-md font-mono text-right"
                        />
                      </div>
                    </div>
                  </div>

                  <button
                    disabled={!canWrite}
                            onClick={() => handleSaveEdit(item.id)}
                    className="w-full py-2 bg-brand-500 hover:bg-brand-700 text-white rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 shadow-xs"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>Save Cost Item</span>
                  </button>
                </div>
              );
            }

            return (
              <div
                key={item.id}
                className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-bold text-slate-900 leading-snug">
                        {item.name}
                      </h4>
                      {item.csiCode && (
                        <span className="text-[10px] text-slate-500 font-mono bg-slate-100 px-1.5 py-0.5 rounded shrink-0">
                          {item.csiCode}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {item.quantity.toLocaleString()} {item.unit}
                    </p>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      disabled={!canWrite}
                            onClick={() => handleStartEdit(item)}
                      className="p-1.5 text-slate-500 hover:text-brand-500 hover:bg-brand-50 rounded-md transition"
                      title="Edit Item"
                      aria-label="Edit Item"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      disabled={!canWrite}
                            onClick={() => handleDeleteItem(item.id)}
                      className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-md transition"
                      title="Delete Item"
                      aria-label="Delete Item"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Sub cost pills */}
                <div className="grid grid-cols-3 gap-1.5 text-[11px] text-slate-600">
                  <div className="bg-slate-50 p-1.5 rounded border border-slate-200/80 text-center">
                    <span className="text-[9px] uppercase font-bold text-slate-400 block">Mat</span>
                    <span className="font-mono font-medium">{formatCurrency(item.materialCost)}</span>
                  </div>
                  <div className="bg-slate-50 p-1.5 rounded border border-slate-200/80 text-center">
                    <span className="text-[9px] uppercase font-bold text-slate-400 block">Labor</span>
                    <span className="font-mono font-medium">{formatCurrency(item.laborCost)}</span>
                  </div>
                  <div className="bg-slate-50 p-1.5 rounded border border-slate-200/80 text-center">
                    <span className="text-[9px] uppercase font-bold text-slate-400 block">Equip</span>
                    <span className="font-mono font-medium">{formatCurrency(item.equipmentCost)}</span>
                  </div>
                </div>

                {/* Direct Cost Footer */}
                <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Direct Cost:
                  </span>
                  <span className="text-sm font-bold font-mono text-slate-900 bg-slate-100 px-2.5 py-0.5 rounded">
                    {formatCurrency(calculateLineDirectCost(item.materialCost, item.laborCost, item.equipmentCost))}
                  </span>
                </div>
              </div>
            );
          })
        )}

        {/* Mobile Add Item Form */}
        {isAddingLine && (
          <form
            onSubmit={handleAddNewItem}
            className="bg-brand-50 border border-blue-200 rounded-xl p-4 shadow-xs space-y-3 text-xs"
          >
            <div className="flex items-center justify-between border-b border-blue-200 pb-2">
              <span className="font-bold text-xs text-brand-800">
                + Add Cost Line Item
              </span>
              <button
                type="button"
                onClick={() => setIsAddingLine(false)}
                className="text-xs text-brand-400 hover:text-brand-800"
              >
                Cancel
              </button>
            </div>

            <div>
              <label className="text-[10px] font-bold text-brand-800 uppercase block mb-1">
                Item Description
              </label>
              <input
                type="text"
                placeholder="e.g., Drywall 5/8 Type X"
                aria-label="New item description"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-md bg-white font-medium"
                required
              />
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-[10px] font-bold text-brand-800 uppercase block mb-1">
                  CSI
                </label>
                <input
                  type="text"
                  placeholder="09 29 00"
                  aria-label="New CSI code"
                  value={newCsi}
                  onChange={(e) => setNewCsi(e.target.value)}
                  className="w-full px-2 py-1.5 border border-slate-200 rounded-md bg-white font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-brand-800 uppercase block mb-1">
                  Quantity
                </label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  aria-label="New quantity"
                  value={newQty}
                  onChange={(e) => setNewQty(Number(e.target.value))}
                  className="w-full px-2 py-1.5 border border-slate-200 rounded-md bg-white font-mono font-bold text-right"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-brand-800 uppercase block mb-1">
                  Unit
                </label>
                <select
                  aria-label="New unit"
                  value={newUnit}
                  onChange={(e) => setNewUnit(e.target.value as UnitType)}
                  className="w-full px-2 py-1.5 border border-slate-200 rounded-md bg-white font-bold"
                >
                  {units.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-[10px] font-bold text-brand-800 uppercase block mb-1">
                  Mat ($)
                </label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  aria-label="New material total in USD"
                  value={newMaterial}
                  onChange={(e) => setNewMaterial(Number(e.target.value))}
                  className="w-full px-2 py-1.5 border border-slate-200 rounded-md bg-white font-mono text-right"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-brand-800 uppercase block mb-1">
                  Labor ($)
                </label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  aria-label="New labor total in USD"
                  value={newLabor}
                  onChange={(e) => setNewLabor(Number(e.target.value))}
                  className="w-full px-2 py-1.5 border border-slate-200 rounded-md bg-white font-mono text-right"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-brand-800 uppercase block mb-1">
                  Equip ($)
                </label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  aria-label="New equipment total in USD"
                  value={newEquipment}
                  onChange={(e) => setNewEquipment(Number(e.target.value))}
                  className="w-full px-2 py-1.5 border border-slate-200 rounded-md bg-white font-mono text-right"
                />
              </div>
            </div>

            <button
              type="submit"
              className="w-full py-2.5 bg-brand-500 hover:bg-brand-700 text-white rounded-md text-xs font-semibold shadow-xs"
            >
              Add Cost Item
            </button>
          </form>
        )}
      </div>

      {/* 4 Summary Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
        {/* Card 1: Direct Cost Sum */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex flex-col justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              Direct Cost Sum
            </p>
            <p className="text-2xl font-bold text-slate-900 mt-1 font-mono">
              {formatCurrency(financials.directCost)}
            </p>
          </div>
          <p className="text-[10px] text-slate-500 mt-4 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />
            <span>Aggregated from {project.estimateItems.length} line items</span>
          </p>
        </div>

        {/* Card 2: Overhead */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex flex-col justify-between relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-brand-500" />
          <div>
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Overhead ({financials.overheadPercentage}%)
              </p>
              <button
                disabled={!canWrite}
            onClick={handleOpenRates}
                className="text-brand-500 bg-brand-50 hover:bg-brand-100 px-1.5 py-0.5 rounded text-[10px] font-bold cursor-pointer transition"
              >
                Edit
              </button>
            </div>
            <p className="text-2xl font-bold text-slate-900 mt-1 font-mono">
              {formatCurrency(financials.overheadAmount)}
            </p>
          </div>
          <p className="text-[10px] text-slate-500 mt-4">
            Applied to direct project costs
          </p>
        </div>

        {/* Card 3: Markup */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex flex-col justify-between relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-brand-500" />
          <div>
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Markup ({financials.markupPercentage}%)
              </p>
              <button
                disabled={!canWrite}
            onClick={handleOpenRates}
                className="text-brand-500 bg-brand-50 hover:bg-brand-100 px-1.5 py-0.5 rounded text-[10px] font-bold cursor-pointer transition"
              >
                Edit
              </button>
            </div>
            <p className="text-2xl font-bold text-slate-900 mt-1 font-mono">
              {formatCurrency(financials.markupAmount)}
            </p>
          </div>
          <p className="text-[10px] text-slate-500 mt-4">
            Applied to direct costs plus overhead
          </p>
        </div>

        {/* Card 4: Final Estimated Price (Dark card) */}
        <div className="bg-slate-900 p-5 rounded-xl border border-slate-900 shadow-xl text-white flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Final Estimated Price
              </p>
              <span className="text-xs font-bold text-emerald-600 bg-emerald-600/20 px-2 py-0.5 rounded-full">
                Target
              </span>
            </div>
            <p className="text-2xl font-black text-white mt-1 font-mono">
              {formatCurrency(financials.finalPrice)}
            </p>
          </div>
          <div className="mt-4 pt-3 border-t border-gray-800 flex items-center justify-between text-xs text-slate-400">
            <span>Estimated Margin:</span>
            <span className="text-emerald-400 font-bold">
              {formatPercentage(financials.marginPercentage)}
            </span>
          </div>
        </div>
      </div>

      {/* Bottom Actions Bar */}
      <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-4 border-t border-slate-200">
        <p className="text-xs text-gray-500">{editingItemId || isAddingLine ? "Save or cancel your open item before continuing." : "Review the completed items before continuing."}</p>

        <button
          onClick={onContinue}
          disabled={Boolean(editingItemId) || isAddingLine}
          className="flex items-center justify-center gap-2 px-6 py-2.5 bg-brand-500 hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-md text-xs font-semibold transition shadow-xs cursor-pointer w-full sm:w-auto"
        >
          <span>Continue to Review</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>

      {/* Rate Adjustment Modal */}
      {showRateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-2xs p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="estimate-rates-title" className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-md p-6 space-y-4 max-h-[90dvh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 id="estimate-rates-title" className="text-base font-bold text-slate-900 flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4 text-brand-500" />
                <span>Adjust Overhead & Markup Rates</span>
              </h3>
              <button
                onClick={() => setShowRateModal(false)}
                aria-label="Close rates"
                className="text-slate-400 hover:text-slate-900"
              >
                ✕
              </button>
            </div>

            {rateError && <p role="alert" className="rounded-md bg-rose-50 p-2 text-xs text-rose-700">{rateError}</p>}
            <div className="space-y-4 text-xs">
              <div>
                <label className="block font-semibold text-slate-600 mb-1">
                  Overhead Percentage (%)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.5"
                    aria-label="Overhead percentage"
                    value={overheadInput}
                    onChange={(e) => setOverheadInput(Number(e.target.value))}
                    className="w-full px-3 py-2 border border-slate-300 rounded font-mono font-bold text-sm"
                  />
                  <span className="font-bold text-slate-500">%</span>
                </div>
                <p className="text-[11px] text-slate-500 mt-1">
                  Covers insurance, office, software, licenses & admin expenses.
                </p>
              </div>

              <div>
                <label className="block font-semibold text-slate-600 mb-1">
                  Markup Percentage (%)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.5"
                    aria-label="Markup percentage"
                    value={markupInput}
                    onChange={(e) => setMarkupInput(Number(e.target.value))}
                    className="w-full px-3 py-2 border border-slate-300 rounded font-mono font-bold text-sm"
                  />
                  <span className="font-bold text-slate-500">%</span>
                </div>
                <p className="text-[11px] text-slate-500 mt-1">
                  Added to direct costs plus overhead; this percentage is markup, not profit margin.
                </p>
              </div>
            </div>

            <div className="pt-3 flex items-center justify-end gap-2 border-t border-slate-200">
              <button
                onClick={() => setShowRateModal(false)}
                className="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-900"
              >
                Cancel
              </button>
              <button
                disabled={!canWrite}
                onClick={handleSaveFinancialRates}
                className="px-4 py-2 bg-brand-500 hover:bg-brand-700 text-white font-semibold rounded text-xs transition"
              >
                Save Rates
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
