import React, { useEffect, useState } from "react";
import { AlertCircle, Boxes, Check, ChevronDown, Edit2, Plus, Search } from "lucide-react";
import type { AssemblyItem, UnitType } from "../types";
import { calculateLineDirectCost, formatCurrency } from "../utils/calculations";
import { validateEstimateInput } from "../utils/manualEstimate";
import { StorageService, type StorageScope } from "../utils/storage";

const units: UnitType[] = ["SF", "LF", "EA", "CY", "SY", "HR", "LS"];
const fieldClass = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";
const rateFields = [
  { key: "materialCostPerUnit", label: "Material" },
  { key: "laborCostPerUnit", label: "Labor" },
  { key: "equipmentCostPerUnit", label: "Equipment" },
] as const;

function unitTotal(assembly: AssemblyItem) {
  return calculateLineDirectCost(assembly.materialCostPerUnit, assembly.laborCostPerUnit, assembly.equipmentCostPerUnit);
}

export const AssembliesPage: React.FC<{ scope: StorageScope; canWrite?: boolean }> = ({ scope, canWrite = false }) => {
  const [assemblies, setAssemblies] = useState<AssemblyItem[]>(() => StorageService.getAssemblies(scope));
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<AssemblyItem | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setAssemblies(StorageService.getAssemblies(scope));
    setDraft(null);
    setExpandedId(null);
    setSearch("");
    setError("");
    setNotice("");
  }, [scope.userId, scope.workspaceId]);

  useEffect(() => { if (!canWrite) setDraft(null); }, [canWrite]);

  const filtered = assemblies.filter((assembly) =>
    `${assembly.name} ${assembly.category} ${assembly.description}`.toLowerCase().includes(search.trim().toLowerCase())
  );
  const editingExisting = Boolean(draft && assemblies.some((assembly) => assembly.id === draft.id));

  const startNew = () => {
    if (!canWrite) return;
    setDraft({
      id: `asm-${crypto.randomUUID()}`, name: "", category: "", description: "", unit: "SF",
      materialCostPerUnit: 0, laborCostPerUnit: 0, equipmentCostPerUnit: 0,
    });
    setError("");
    setNotice("");
  };

  const startEdit = (assembly: AssemblyItem) => {
    if (!canWrite) return;
    setDraft({ ...assembly });
    setError("");
    setNotice("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const saveAssembly = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canWrite) return;
    if (!draft) return;
    const validationError = validateEstimateInput(draft.name, 1, rateFields.map(({ key }) => draft[key]));
    if (validationError) { setError(validationError); return; }
    const saved: AssemblyItem = {
      ...draft,
      name: draft.name.trim(), category: draft.category.trim(), description: draft.description.trim(),
      materialCostPerUnit: Number(draft.materialCostPerUnit.toFixed(2)),
      laborCostPerUnit: Number(draft.laborCostPerUnit.toFixed(2)),
      equipmentCostPerUnit: Number(draft.equipmentCostPerUnit.toFixed(2)),
    };
    const updated = editingExisting ? assemblies.map((assembly) => assembly.id === saved.id ? saved : assembly) : [saved, ...assemblies];
    if (!StorageService.saveAssemblies(updated, scope)) {
      setError("This device could not save the assembly. Keep this form open and free up browser storage before retrying.");
      return;
    }
    setAssemblies(updated);
    setDraft(null);
    setExpandedId(saved.id);
    setSearch("");
    setError("");
    setNotice("Assembly saved on this device.");
  };

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-6xl mx-auto space-y-6 font-sans [&_button:disabled]:cursor-not-allowed [&_button:disabled]:opacity-40">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-extrabold text-slate-900 tracking-tight">Assemblies</h1>
          <p className="text-sm text-slate-500 mt-1 max-w-2xl">Build your own unit rates from material, labor and equipment costs.</p>
        </div>
        <button onClick={startNew} disabled={!canWrite || Boolean(draft)} className="flex shrink-0 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-xs transition hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
          <Plus className="h-4 w-4" /> New Assembly
        </button>
      </div>
      <div className="rounded-xl border border-blue-100 bg-blue-50/60 p-4 text-xs leading-relaxed text-blue-900">
        Add rates from your quotes or actual job costs. This library is saved on this device for your account and workspace. No paid price feed is required.
      </div>
      {notice && <p role="status" className="flex items-center gap-2 text-sm text-emerald-700"><Check className="h-4 w-4" />{notice}</p>}
      {error && <p role="alert" className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"><AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />{error}</p>}
      {draft && (
        <form onSubmit={saveAssembly} className="rounded-xl border border-blue-200 bg-white p-4 sm:p-5 shadow-xs space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-bold text-slate-900">{editingExisting ? "Edit assembly" : "New assembly"}</h2>
            <button type="button" onClick={() => { setDraft(null); setError(""); }} className="text-sm text-slate-600 hover:text-slate-900">Cancel</button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block text-xs font-semibold text-slate-600 sm:col-span-2">Assembly name
              <input autoFocus required maxLength={200} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="e.g., Interior wall finishing" className={`${fieldClass} mt-1`} />
            </label>
            <label className="block text-xs font-semibold text-slate-600">Trade / category
              <input maxLength={100} value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} placeholder="e.g., Finishes" className={`${fieldClass} mt-1`} />
            </label>
            <label className="block text-xs font-semibold text-slate-600">Unit
              <select value={draft.unit} onChange={(event) => setDraft({ ...draft, unit: event.target.value as UnitType })} className={`${fieldClass} mt-1`}>
                {units.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
              </select>
            </label>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-xs font-bold text-slate-700">Your costs per 1 {draft.unit} (USD)</legend>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {rateFields.map(({ key, label }) => <label key={key} className="block text-xs font-semibold text-slate-600">{label}
                <input type="number" min="0" step="0.01" required value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) })} className={`${fieldClass} mt-1 font-mono`} />
              </label>)}
            </div>
          </fieldset>
          <label className="block text-xs font-semibold text-slate-600">Scope and quote notes
            <textarea rows={3} maxLength={4000} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="What is included, exclusions, supplier quote and quote date" className={`${fieldClass} mt-1 resize-y`} />
          </label>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <p className="text-sm text-slate-600">Unit rate: <strong className="font-mono text-slate-900">{unitTotal(draft) > 0 ? `${formatCurrency(unitTotal(draft))} / ${draft.unit}` : "Not priced"}</strong></p>
            <button type="submit" className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700">Save Assembly</button>
          </div>
        </form>
      )}
      <div className="relative">
        <Search className="h-4 w-4 text-slate-400 absolute left-3 top-3" />
        <input aria-label="Search assemblies" placeholder="Search by name, trade or scope..." value={search} onChange={(event) => setSearch(event.target.value)} className={`${fieldClass} pl-9`} />
      </div>
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 sm:p-12 text-center">
          <Boxes className="mx-auto h-9 w-9 text-slate-300" />
          <h2 className="mt-3 text-base font-bold text-slate-900">{search ? "No matching assemblies" : "Your assembly library starts here"}</h2>
          <p className="mt-1 text-sm text-slate-500">{search ? "Try another search or clear the filter." : "Create a reusable cost breakdown using your own prices."}</p>
          {search && <button onClick={() => setSearch("")} className="mt-3 text-sm font-semibold text-blue-600 hover:underline">Clear search</button>}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          {filtered.map((assembly) => {
            const total = unitTotal(assembly);
            const expanded = expandedId === assembly.id;
            return <article key={assembly.id} className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs space-y-4">
              <div className="flex flex-col sm:flex-row justify-between gap-3">
                <div className="min-w-0">
                  <span className="inline-block rounded bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-600">{assembly.category || "Uncategorized"}</span>
                  <h2 className="mt-2 break-words text-base font-bold text-slate-900">{assembly.name}</h2>
                </div>
                <div className="sm:text-right shrink-0">
                  <span className="block text-[10px] uppercase font-bold tracking-wide text-slate-400">Your unit rate</span>
                  <p className={`mt-1 font-mono text-base font-bold ${total > 0 ? "text-slate-900" : "text-amber-700"}`}>{total > 0 ? `${formatCurrency(total)} / ${assembly.unit}` : "Not priced"}</p>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
                <button aria-expanded={expanded} aria-controls={`assembly-${assembly.id}`} onClick={() => setExpandedId(expanded ? null : assembly.id)} className="flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-800">{expanded ? "Hide details" : "View breakdown"}<ChevronDown className={`h-4 w-4 transition ${expanded ? "rotate-180" : ""}`} /></button>
                <button disabled={!canWrite || Boolean(draft)} onClick={() => startEdit(assembly)} aria-label={`Edit ${assembly.name}`} className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40"><Edit2 className="h-3.5 w-3.5" /> Edit</button>
              </div>
              {expanded && <div id={`assembly-${assembly.id}`} className="space-y-3">
                <dl className="rounded-lg bg-slate-50 p-3 space-y-2 text-xs">
                  {rateFields.map(({ key, label }) => <div key={key} className="flex justify-between gap-3"><dt className="text-slate-600">{label} / {assembly.unit}</dt><dd className="font-mono font-semibold text-slate-800">{formatCurrency(assembly[key])}</dd></div>)}
                </dl>
                <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-500">{assembly.description || "No scope or quote notes added."}</p>
                <p className="text-[11px] text-slate-500">For a project quantity, multiply each cost above by that quantity and enter the totals in Estimate.</p>
              </div>}
            </article>;
          })}
        </div>
      )}
    </div>
  );
};
