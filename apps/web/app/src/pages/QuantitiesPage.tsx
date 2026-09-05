import React, { useEffect, useState } from "react";
import {
  Plus,
  Trash2,
  Edit2,
  ArrowRight,
  Sparkles,
  Check,
  AlertCircle,
  X,
} from "lucide-react";
import { Project, QuantityItem, UnitType } from "../types";
import { createUnpricedEstimateItem, updateTakeoffQuantity, validateEstimateInput } from "../utils/manualEstimate";
import { Stepper } from "../components/Stepper";
import { ProjectStep } from "../components/Header";

interface QuantitiesPageProps {
  project: Project;
  canWrite?: boolean;
  onUpdateProject: (updated: Project) => void;
  onContinue: () => void;
  onSelectStep: (step: ProjectStep) => void;
  onOpenAIAssistant: () => void;
}

export const QuantitiesPage: React.FC<QuantitiesPageProps> = ({
  project,
  canWrite = false,
  onUpdateProject,
  onContinue,
  onSelectStep,
  onOpenAIAssistant,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState<string>("");
  const [editQty, setEditQty] = useState<number>(0);
  const [editUnit, setEditUnit] = useState<UnitType>("SF");

  const [isAddingNew, setIsAddingNew] = useState<boolean>(false);
  const [newName, setNewName] = useState<string>("");
  const [newQty, setNewQty] = useState<number>(1);
  const [newUnit, setNewUnit] = useState<UnitType>("SF");
  const [error, setError] = useState<string>("");

  useEffect(() => { if (!canWrite) { setEditingId(null); setIsAddingNew(false); } }, [canWrite]);

  const units: UnitType[] = ["SF", "LF", "EA", "CY", "SY", "HR", "LS"];

  const handleStartEdit = (item: QuantityItem) => {
    if (!canWrite) return;
    setError("");
    setIsAddingNew(false);
    setEditingId(item.id);
    setEditName(item.name);
    setEditQty(item.quantity);
    setEditUnit(item.unit);
  };

  const handleSaveEdit = (id: string) => {
    if (!canWrite) return;
    const validationError = validateEstimateInput(editName, editQty);
    if (validationError) {
      setError(validationError);
      return;
    }
    try {
      onUpdateProject(updateTakeoffQuantity(project, id, { name: editName, quantity: editQty, unit: editUnit }));
    } catch (error) {
      setError(error instanceof Error ? error.message : "This item could not be updated.");
      return;
    }
    setEditingId(null);
    setError("");
  };

  const handleDeleteItem = (id: string) => {
    if (!canWrite) return;
    const updatedQuantities = project.quantities
      .filter((item) => item.id !== id)
      .map((item, idx) => ({ ...item, itemNumber: idx + 1 }));

    const updatedEstimateItems = project.estimateItems.filter(
      (est) => est.quantityId !== id
    );

    onUpdateProject({
      ...project,
      quantities: updatedQuantities,
      estimateItems: updatedEstimateItems,
    });
  };

  const handleAddNewItem = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite) return;
    const validationError = validateEstimateInput(newName, newQty);
    if (validationError) {
      setError(validationError);
      return;
    }

    const newId = `qty-${crypto.randomUUID()}`;
    const newItem: QuantityItem = {
      id: newId,
      itemNumber: project.quantities.length + 1,
      name: newName.trim(),
      quantity: Number(newQty) || 0,
      unit: newUnit,
    };

    const newEstItem = createUnpricedEstimateItem(newItem);

    onUpdateProject({
      ...project,
      quantities: [...project.quantities, newItem],
      estimateItems: [...project.estimateItems, newEstItem],
    });

    setNewName("");
    setNewQty(1);
    setIsAddingNew(false);
    setError("");
  };

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-6xl mx-auto space-y-6 font-sans [&_button:disabled]:cursor-not-allowed [&_button:disabled]:opacity-40">
      {/* Title & Subtitle */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-[#111827] tracking-tight">
            Quantities
          </h2>
          <p className="text-xs text-[#6b7280] mt-0.5">
            Enter measured quantities, then add your actual costs in Estimate.
          </p>
        </div>

        {/* AI Missing Scope Trigger */}
        <button
          onClick={onOpenAIAssistant}
          className="self-start sm:self-auto flex items-center gap-1.5 px-3 py-1.5 bg-[#eff6ff] border border-blue-200 text-[#2563eb] hover:bg-blue-100 rounded-md text-xs font-semibold transition cursor-pointer shadow-xs"
        >
          <Sparkles className="w-3.5 h-3.5 text-[#2563eb]" />
          <span>Scope Help</span>
        </button>
      </div>

      {/* Stepper timeline */}
      <Stepper currentStep="quantities" onSelectStep={(step) => { if (editingId || isAddingNew) { setError("Save or cancel your open item before changing steps."); return; } onSelectStep(step); }} />

      <div className="rounded-xl border border-blue-100 bg-blue-50/60 px-4 py-3 text-xs leading-relaxed text-blue-900">
        New items start with no costs. Quantity edits update linked estimate costs proportionally.
        Changing a unit clears its costs so you can price it again.
      </div>

      {/* Error Message */}
      {error && (
        <div role="alert" className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-lg font-medium flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Desktop Takeoff Table (hidden on mobile) */}
      <div className="hidden md:block bg-white border border-[#e5e7eb] rounded-xl shadow-xs overflow-hidden">
        <table className="w-full text-left text-xs">
          <thead className="bg-[#f9fafb] border-b border-[#e5e7eb] text-[#6b7280] font-bold text-[10px] uppercase tracking-wider">
            <tr>
              <th className="py-3 px-5 w-14 text-center">#</th>
              <th className="py-3 px-5">ITEM</th>
              <th className="py-3 px-5 text-right w-44">QUANTITY</th>
              <th className="py-3 px-5 text-center w-28">UNIT</th>
              <th className="py-3 px-5 text-right w-24">ACTIONS</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#f3f4f6]">
            {project.quantities.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-12 text-center text-[#9ca3af]">
                  No quantities added yet. Click &quot;+ Add Item&quot; to build your takeoff.
                </td>
              </tr>
            ) : (
              project.quantities.map((item, index) => {
                const isEditing = editingId === item.id;

                return (
                  <tr
                    key={item.id}
                    className="hover:bg-[#f9fafb] transition group"
                  >
                    {/* Index */}
                    <td className="py-3 px-5 text-center font-mono text-[#9ca3af] text-xs">
                      {index + 1}
                    </td>

                    {/* Item Name */}
                    <td className="py-3 px-5 font-semibold text-[#111827]">
                      {isEditing ? (
                        <input
                          type="text"
                          aria-label="Item description"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="w-full px-2 py-1 border border-[#2563eb] rounded text-xs font-semibold"
                        />
                      ) : (
                        <span
                          onClick={() => handleStartEdit(item)}
                          className="cursor-pointer hover:text-[#2563eb] transition"
                          title="Click to edit"
                        >
                          {item.name}
                        </span>
                      )}
                    </td>

                    {/* Quantity */}
                    <td className="py-3 px-5 text-right font-mono font-bold text-[#111827]">
                      {isEditing ? (
                        <input
                          type="number"
                          min="0"
                          step="any"
                          aria-label="Quantity"
                          value={editQty}
                          onChange={(e) => setEditQty(Number(e.target.value))}
                          className="w-28 px-2 py-1 border border-[#2563eb] rounded text-xs text-right font-mono font-bold"
                        />
                      ) : (
                        <span
                          onClick={() => handleStartEdit(item)}
                          className="cursor-pointer hover:text-[#2563eb] transition"
                        >
                          {item.quantity.toLocaleString()}
                        </span>
                      )}
                    </td>

                    {/* Unit */}
                    <td className="py-3 px-5 text-center font-semibold text-[#4b5563]">
                      {isEditing ? (
                        <select
                          aria-label="Unit"
                          value={editUnit}
                          onChange={(e) => setEditUnit(e.target.value as UnitType)}
                          className="px-2 py-1 border border-[#2563eb] rounded text-xs bg-white font-semibold"
                        >
                          {units.map((u) => (
                            <option key={u} value={u}>
                              {u}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="px-2 py-0.5 rounded bg-[#f3f4f6] text-[#374151] text-[10px] font-bold">
                          {item.unit}
                        </span>
                      )}
                    </td>

                    {/* Actions */}
                    <td className="py-3 px-5 text-right">
                      {isEditing ? (
                        <div className="flex items-center justify-end gap-1">
                          <button
                            disabled={!canWrite}
                            onClick={() => handleSaveEdit(item.id)}
                            className="p-1 bg-emerald-600 text-white rounded hover:bg-emerald-700 transition"
                            title="Save item"
                            aria-label="Save item"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => { setEditingId(null); setError(""); }} className="p-1 text-gray-500 hover:text-gray-900" aria-label="Cancel edit" title="Cancel edit">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-end gap-1 text-[#9ca3af]">
                          <button
                            disabled={!canWrite}
                            onClick={() => handleStartEdit(item)}
                            className="p-1 hover:text-[#2563eb] transition"
                            title="Edit"
                            aria-label="Edit item"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            disabled={!canWrite}
                            onClick={() => handleDeleteItem(item.id)}
                            className="p-1 hover:text-rose-600 transition"
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

        {/* Add Item Bottom Row Desktop */}
        {isAddingNew ? (
          <form
            onSubmit={handleAddNewItem}
            className="p-4 bg-[#eff6ff] border-t border-blue-200 grid grid-cols-12 gap-3 items-center"
          >
            <div className="col-span-1 text-center font-mono text-[#9ca3af] text-xs">
              {project.quantities.length + 1}
            </div>

            <div className="col-span-5">
              <input
                type="text"
                placeholder="Item name (e.g., Drywall, Baseboard, Doors)"
                aria-label="New item description"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full px-3 py-1.5 border border-[#e5e7eb] rounded text-xs bg-white font-medium"
                required
              />
            </div>

            <div className="col-span-3">
              <input
                type="number"
                min="0"
                step="any"
                placeholder="Quantity"
                aria-label="New quantity"
                value={newQty}
                onChange={(e) => setNewQty(Number(e.target.value))}
                className="w-full px-3 py-1.5 border border-[#e5e7eb] rounded text-xs text-right font-mono font-bold bg-white"
                required
              />
            </div>

            <div className="col-span-1">
              <select
                aria-label="New unit"
                value={newUnit}
                onChange={(e) => setNewUnit(e.target.value as UnitType)}
                className="w-full px-2 py-1.5 border border-[#e5e7eb] rounded text-xs bg-white font-bold"
              >
                {units.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </div>

            <div className="col-span-2 flex items-center justify-end gap-2">
              <button
                type="submit"
                className="px-3 py-1.5 bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded text-xs font-semibold transition"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => setIsAddingNew(false)}
                className="px-2.5 py-1.5 text-[#6b7280] hover:text-[#111827] text-xs"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="p-3 border-t border-[#e5e7eb] bg-white">
            <button
              disabled={!canWrite}
              onClick={() => { if (!canWrite) return; setIsAddingNew(true); setEditingId(null); setError(""); }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[#2563eb] hover:bg-[#eff6ff] rounded-md text-xs font-semibold transition cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Item</span>
            </button>
          </div>
        )}
      </div>

      {/* Mobile Stacked Editable Takeoff Cards (visible on mobile only) */}
      <div className="md:hidden space-y-3">
        {project.quantities.length === 0 ? (
          <div className="bg-white border border-dashed border-[#e5e7eb] rounded-xl p-8 text-center text-[#9ca3af]">
            <p className="text-xs">No quantities added yet.</p>
            <p className="text-[11px] text-[#6b7280] mt-1">Tap below to add your first takeoff item.</p>
          </div>
        ) : (
          project.quantities.map((item, index) => {
            const isEditing = editingId === item.id;

            if (isEditing) {
              return (
                <div
                  key={item.id}
                  className="bg-white border-2 border-[#2563eb] rounded-xl p-4 shadow-sm space-y-3"
                >
                  <div className="flex items-center justify-between border-b border-[#f3f4f6] pb-2">
                    <span className="font-mono text-xs font-bold text-[#2563eb]">
                      Item #{index + 1} (Editing)
                    </span>
                    <button
                      onClick={() => setEditingId(null)}
                      className="text-xs text-[#6b7280] hover:text-[#111827]"
                    >
                      Cancel
                    </button>
                  </div>

                  <div className="space-y-2">
                    <div>
                      <label className="text-[10px] font-bold text-[#6b7280] uppercase block mb-1">
                        Item Description
                      </label>
                      <input
                        type="text"
                        aria-label="Item description"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="w-full px-3 py-2 border border-[#e5e7eb] rounded-md text-xs font-semibold focus:border-[#2563eb] focus:outline-hidden"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[10px] font-bold text-[#6b7280] uppercase block mb-1">
                          Quantity
                        </label>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          aria-label="Quantity"
                          value={editQty}
                          onChange={(e) => setEditQty(Number(e.target.value))}
                          className="w-full px-3 py-2 border border-[#e5e7eb] rounded-md text-xs font-mono font-bold focus:border-[#2563eb] focus:outline-hidden"
                        />
                      </div>

                      <div>
                        <label className="text-[10px] font-bold text-[#6b7280] uppercase block mb-1">
                          Unit
                        </label>
                        <select
                          aria-label="Unit"
                          value={editUnit}
                          onChange={(e) => setEditUnit(e.target.value as UnitType)}
                          className="w-full px-3 py-2 border border-[#e5e7eb] rounded-md text-xs font-semibold bg-white focus:border-[#2563eb] focus:outline-hidden"
                        >
                          {units.map((u) => (
                            <option key={u} value={u}>
                              {u}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  <div className="pt-2 flex items-center justify-end gap-2">
                    <button
                      disabled={!canWrite}
                            onClick={() => handleSaveEdit(item.id)}
                      className="w-full py-2 bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 shadow-xs"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>Save Item Changes</span>
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <div
                key={item.id}
                className="bg-white border border-[#e5e7eb] rounded-xl p-4 shadow-xs flex flex-col justify-between gap-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2.5 min-w-0">
                    <span className="w-6 h-6 rounded-md bg-[#f3f4f6] text-[#6b7280] font-mono text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                      {index + 1}
                    </span>
                    <div className="min-w-0">
                      <h4 className="text-sm font-bold text-[#111827] leading-snug">
                        {item.name}
                      </h4>
                      <p className="text-[11px] text-[#6b7280] mt-0.5">
                        {item.category || "Takeoff Item"}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      disabled={!canWrite}
                            onClick={() => handleStartEdit(item)}
                      className="p-1.5 text-[#6b7280] hover:text-[#2563eb] hover:bg-[#eff6ff] rounded-md transition"
                      title="Edit Item"
                      aria-label="Edit Item"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      disabled={!canWrite}
                            onClick={() => handleDeleteItem(item.id)}
                      className="p-1.5 text-[#9ca3af] hover:text-rose-600 hover:bg-rose-50 rounded-md transition"
                      title="Delete Item"
                      aria-label="Delete Item"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="bg-[#f9fafb] border border-[#e5e7eb] rounded-lg p-2.5 flex items-center justify-between text-xs">
                  <div>
                    <span className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider block">
                      Quantity
                    </span>
                    <span className="text-base font-bold font-mono text-[#111827]">
                      {item.quantity.toLocaleString()}
                    </span>
                  </div>

                  <div className="text-right">
                    <span className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider block">
                      Unit
                    </span>
                    <span className="inline-block px-2 py-0.5 rounded bg-white border border-[#e5e7eb] text-[#2563eb] font-bold text-xs">
                      {item.unit}
                    </span>
                  </div>
                </div>
              </div>
            );
          })
        )}

        {/* Mobile Add New Item Form / Button */}
        {isAddingNew ? (
          <form
            onSubmit={handleAddNewItem}
            className="bg-[#eff6ff] border border-blue-200 rounded-xl p-4 shadow-xs space-y-3"
          >
            <div className="flex items-center justify-between border-b border-blue-200 pb-2">
              <span className="font-bold text-xs text-[#1e40af]">
                + Add Takeoff Line Item #{project.quantities.length + 1}
              </span>
              <button
                type="button"
                onClick={() => setIsAddingNew(false)}
                className="text-xs text-[#3b82f6] hover:text-[#1e40af]"
              >
                Cancel
              </button>
            </div>

            <div>
              <label className="text-[10px] font-bold text-[#1e40af] uppercase block mb-1">
                Item Description
              </label>
              <input
                type="text"
                placeholder="e.g., Drywall, Baseboard, Doors, Framing"
                aria-label="New item description"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full px-3 py-2 border border-[#e5e7eb] rounded-md text-xs bg-white font-medium focus:border-[#2563eb] focus:outline-hidden"
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] font-bold text-[#1e40af] uppercase block mb-1">
                  Quantity
                </label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  placeholder="Quantity"
                  aria-label="New quantity"
                  value={newQty}
                  onChange={(e) => setNewQty(Number(e.target.value))}
                  className="w-full px-3 py-2 border border-[#e5e7eb] rounded-md text-xs font-mono font-bold bg-white focus:border-[#2563eb] focus:outline-hidden"
                  required
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-[#1e40af] uppercase block mb-1">
                  Unit
                </label>
                <select
                  aria-label="New unit"
                  value={newUnit}
                  onChange={(e) => setNewUnit(e.target.value as UnitType)}
                  className="w-full px-3 py-2 border border-[#e5e7eb] rounded-md text-xs bg-white font-bold focus:border-[#2563eb] focus:outline-hidden"
                >
                  {units.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <button
              type="submit"
              className="w-full py-2.5 bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-md text-xs font-semibold shadow-xs"
            >
              Add Takeoff Item
            </button>
          </form>
        ) : (
          <button
            disabled={!canWrite}
              onClick={() => { if (!canWrite) return; setIsAddingNew(true); setEditingId(null); setError(""); }}
            className="w-full py-3 bg-white hover:bg-[#f9fafb] border border-dashed border-[#2563eb]/40 hover:border-[#2563eb] rounded-xl text-xs font-semibold text-[#2563eb] flex items-center justify-center gap-1.5 transition shadow-2xs"
          >
            <Plus className="w-4 h-4" />
            <span>Add Takeoff Item</span>
          </button>
        )}
      </div>

      {/* Bottom Continue Action */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-4 border-t border-[#e5e7eb]">
        <p className="text-xs text-gray-500">{editingId || isAddingNew ? "Save or cancel your open item before continuing." : `${project.quantities.length} takeoff item${project.quantities.length === 1 ? "" : "s"} ready for pricing`}</p>
        <button
          onClick={onContinue}
          disabled={Boolean(editingId) || isAddingNew}
          className="w-full sm:w-auto flex items-center justify-center gap-2 px-5 py-2.5 bg-[#2563eb] hover:bg-[#1d4ed8] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-md text-xs font-semibold transition shadow-xs cursor-pointer"
        >
          <span>Continue to Estimate</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
