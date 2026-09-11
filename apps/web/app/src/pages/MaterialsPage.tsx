import React, { useEffect, useState } from "react";
import { AlertCircle, Check, Edit2, Package, Plus, Search, Trash2, Undo2 } from "lucide-react";
import type { AssemblyItem, MaterialItem, UnitType } from "../types";
import { ApiError, getWorkspaceEstimatingCatalog, saveWorkspaceEstimatingCatalog } from "../services/api";
import { formatCurrency } from "../utils/calculations";
import { validateEstimateInput } from "../utils/manualEstimate";
import { StorageService, type StorageScope } from "../utils/storage";

const units: UnitType[] = ["SF", "LF", "EA", "CY", "SY", "HR", "LS"];
const fieldClass = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";
const unitCost = (item: MaterialItem) => item.unitCost ?? item.unitPrice ?? 0;
const updatedLabel = (value: string) => Number.isNaN(Date.parse(value)) ? value : new Date(value).toLocaleDateString();

export const MaterialsPage: React.FC<{ scope: StorageScope; canWrite?: boolean }> = ({ scope, canWrite = false }) => {
  const [materials, setMaterials] = useState<MaterialItem[]>(() => StorageService.getMaterials(scope));
  const [catalogAssemblies, setCatalogAssemblies] = useState<AssemblyItem[]>(() => StorageService.getAssemblies(scope));
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [catalogReady, setCatalogReady] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [savingCatalog, setSavingCatalog] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [draft, setDraft] = useState<MaterialItem | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deleted, setDeleted] = useState<{ item: MaterialItem; index: number } | null>(null);

  useEffect(() => {
    let active = true;
    const cachedMaterials = StorageService.getMaterials(scope);
    const cachedAssemblies = StorageService.getAssemblies(scope);
    setMaterials(cachedMaterials);
    setCatalogAssemblies(cachedAssemblies);
    setCatalogRevision(0);
    setCatalogReady(false);
    setCatalogLoading(true);
    setDraft(null);
    setDeleted(null);
    setSearch("");
    setSelectedCategory("all");
    setError("");
    setNotice("");
    void getWorkspaceEstimatingCatalog(scope.workspaceId).then((catalog) => {
      if (!active) return;
      const useCachedSeed = catalog.revision === 0 && canWrite;
      setMaterials(useCachedSeed ? cachedMaterials : catalog.materials);
      setCatalogAssemblies(useCachedSeed ? cachedAssemblies : catalog.assemblies);
      setCatalogRevision(catalog.revision);
      setCatalogReady(true);
      setCatalogLoading(false);
    }).catch((loadError) => {
      if (!active) return;
      setCatalogLoading(false);
      setCatalogReady(false);
      setError(loadError instanceof Error ? `${loadError.message} Cached materials are read-only until the workspace catalog reconnects.` : "Workspace catalog could not load. Cached materials are read-only until it reconnects.");
    });
    return () => { active = false; };
  }, [scope.userId, scope.workspaceId, canWrite]);

  const categories = Array.from(new Set(materials.map((item) => item.category).filter(Boolean))).sort();
  useEffect(() => { if (!canWrite) setDraft(null); }, [canWrite]);

  const canEditCatalog = canWrite && catalogReady && !catalogLoading && !savingCatalog;
  const filtered = materials.filter((item) =>
    `${item.name} ${item.supplier || ""}`.toLowerCase().includes(search.trim().toLowerCase()) &&
    (selectedCategory === "all" || item.category === selectedCategory)
  );
  const editingExisting = Boolean(draft && materials.some((item) => item.id === draft.id));

  const applyLatest = (catalog: Awaited<ReturnType<typeof getWorkspaceEstimatingCatalog>>) => {
    setMaterials(catalog.materials);
    setCatalogAssemblies(catalog.assemblies);
    setCatalogRevision(catalog.revision);
  };

  const persist = async (updated: MaterialItem[]) => {
    if (!canEditCatalog) return false;
    setSavingCatalog(true);
    try {
      const saved = await saveWorkspaceEstimatingCatalog(scope.workspaceId, {
        materials: updated,
        assemblies: catalogAssemblies,
        expectedRevision: catalogRevision,
      });
      applyLatest(saved);
      setError("");
      return true;
    } catch (saveError) {
      if (saveError instanceof ApiError && saveError.status === 409) {
        try {
          const latest = await getWorkspaceEstimatingCatalog(scope.workspaceId);
          applyLatest(latest);
          setError("This catalog changed in another session. Your edit was not saved. Review the latest values and retry.");
        } catch {
          setError("This catalog changed in another session, and the latest version could not be reloaded. Retry before editing again.");
          setCatalogReady(false);
        }
      } else {
        setError(saveError instanceof Error ? saveError.message : "Workspace catalog could not be saved.");
      }
      return false;
    } finally {
      setSavingCatalog(false);
    }
  };

  const startNew = () => {
    if (!canEditCatalog) return;
    setDraft({ id: `mat-${crypto.randomUUID()}`, name: "", category: "", unit: "SF", unitCost: 0, supplier: "", lastUpdated: "" });
    setError("");
    setNotice("");
  };

  const startEdit = (item: MaterialItem) => {
    if (!canEditCatalog) return;
    setDraft({ ...item, unitCost: unitCost(item) });
    setError("");
    setNotice("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const saveMaterial = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canEditCatalog || !draft) return;
    const validationError = validateEstimateInput(draft.name, 1, [unitCost(draft)]);
    if (validationError) { setError(validationError); return; }
    const saved: MaterialItem = {
      ...draft, name: draft.name.trim(), category: draft.category.trim(), supplier: draft.supplier?.trim() || "",
      unitCost: Number(unitCost(draft).toFixed(2)), unitPrice: Number(unitCost(draft).toFixed(2)), lastUpdated: new Date().toISOString(),
    };
    const updated = editingExisting ? materials.map((item) => item.id === saved.id ? saved : item) : [saved, ...materials];
    if (!await persist(updated)) return;
    setDraft(null);
    setSearch("");
    setSelectedCategory("all");
    setNotice("Material saved to the workspace catalog.");
  };

  const deleteMaterial = async (item: MaterialItem) => {
    if (!canEditCatalog) return;
    const index = materials.findIndex((candidate) => candidate.id === item.id);
    const updated = materials.filter((candidate) => candidate.id !== item.id);
    if (!await persist(updated)) return;
    setDeleted({ item, index });
    if (!updated.some((candidate) => candidate.category === selectedCategory)) setSelectedCategory("all");
    setNotice("Material removed from the workspace catalog.");
  };

  const undoDelete = async () => {
    if (!canEditCatalog || !deleted) return;
    const updated = [...materials];
    updated.splice(deleted.index, 0, deleted.item);
    if (!await persist(updated)) return;
    setDeleted(null);
    setNotice("Material restored to the workspace catalog.");
  };

  const actions = (item: MaterialItem) => <div className="flex items-center justify-end gap-1 shrink-0">
    <button disabled={!canEditCatalog || Boolean(draft)} onClick={() => startEdit(item)} aria-label={`Edit ${item.name}`} title="Edit material" className="rounded-md p-2 text-slate-500 hover:bg-blue-50 hover:text-blue-600 disabled:opacity-40"><Edit2 className="h-4 w-4" /></button>
    <button disabled={!canEditCatalog || Boolean(draft)} onClick={() => void deleteMaterial(item)} aria-label={`Delete ${item.name}`} title="Delete material" className="rounded-md p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"><Trash2 className="h-4 w-4" /></button>
  </div>;

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-6xl mx-auto space-y-6 font-sans [&_button:disabled]:cursor-not-allowed [&_button:disabled]:opacity-40">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-extrabold text-slate-900 tracking-tight">Materials Library</h1>
          <p className="mt-1 text-sm text-slate-500">Keep your supplier quotes and actual material prices in one shared workspace catalog.</p>
        </div>
        <button onClick={startNew} disabled={!canEditCatalog || Boolean(draft)} className="flex shrink-0 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-xs hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"><Plus className="h-4 w-4" />New Material</button>
      </div>
      <div className="rounded-xl border border-blue-100 bg-blue-50/60 p-4 text-xs leading-relaxed text-blue-900">
        {catalogLoading ? "Loading the shared workspace catalog..." : catalogRevision === 0 && canWrite ? "This workspace has no server catalog yet. Your existing local library is ready to become revision 1 on the next saved change." : `Workspace catalog revision ${catalogRevision}. Changes are shared across signed-in workspace members.`}
      </div>
      {error && <p role="alert" className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</p>}
      {(notice || deleted) && <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <p role="status" className="flex items-center gap-2 text-sm text-emerald-700"><Check className="h-4 w-4" />{notice}</p>
        {deleted && <button disabled={!canEditCatalog} onClick={() => void undoDelete()} className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:underline"><Undo2 className="h-4 w-4" />Undo last removal</button>}
      </div>}
      {draft && <form onSubmit={saveMaterial} className="rounded-xl border border-blue-200 bg-white p-4 sm:p-5 shadow-xs space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-bold text-slate-900">{editingExisting ? "Edit material" : "New material"}</h2>
          <button type="button" disabled={savingCatalog} onClick={() => { setDraft(null); setError(""); }} className="text-sm text-slate-600 hover:text-slate-900">Cancel</button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block text-xs font-semibold text-slate-600 sm:col-span-2">Material name
            <input autoFocus required maxLength={200} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="e.g., 5/8 inch drywall board" className={`${fieldClass} mt-1`} />
          </label>
          <label className="block text-xs font-semibold text-slate-600">Category
            <input list="material-categories" maxLength={120} value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} placeholder="e.g., Drywall" className={`${fieldClass} mt-1`} />
            <datalist id="material-categories">{categories.map((category) => <option key={category} value={category} />)}</datalist>
          </label>
          <label className="block text-xs font-semibold text-slate-600">Supplier
            <input maxLength={200} value={draft.supplier || ""} onChange={(event) => setDraft({ ...draft, supplier: event.target.value })} placeholder="Supplier name, if known" className={`${fieldClass} mt-1`} />
          </label>
          <label className="block text-xs font-semibold text-slate-600">Unit
            <select value={draft.unit} onChange={(event) => setDraft({ ...draft, unit: event.target.value as UnitType })} className={`${fieldClass} mt-1`}>{units.map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select>
          </label>
          <label className="block text-xs font-semibold text-slate-600">Your cost per 1 {draft.unit} (USD)
            <input type="number" min="0" step="0.01" required value={unitCost(draft)} onChange={(event) => setDraft({ ...draft, unitCost: Number(event.target.value) })} className={`${fieldClass} mt-1 font-mono`} />
          </label>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-slate-100 pt-4">
          <p className="text-xs text-slate-500">Leave the cost at zero until you have a price.</p>
          <button type="submit" disabled={!canEditCatalog} className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700">{savingCatalog ? "Saving..." : "Save Material"}</button>
        </div>
      </form>}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
          <input aria-label="Search materials" placeholder="Search by material or supplier..." value={search} onChange={(event) => setSearch(event.target.value)} className={`${fieldClass} pl-9`} />
        </div>
        <select aria-label="Filter by category" value={selectedCategory} onChange={(event) => setSelectedCategory(event.target.value)} className={`${fieldClass} sm:w-52`}>
          <option value="all">All categories</option>{categories.map((category) => <option key={category} value={category}>{category}</option>)}
        </select>
      </div>
      {filtered.length === 0 ? <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 sm:p-12 text-center">
        <Package className="mx-auto h-9 w-9 text-slate-300" />
        <h2 className="mt-3 text-base font-bold text-slate-900">{materials.length ? "No matching materials" : "Your material library starts here"}</h2>
        <p className="mt-1 text-sm text-slate-500">{materials.length ? "Try another search or category." : "Add a material and the price from your supplier quote."}</p>
        {materials.length > 0 && <button onClick={() => { setSearch(""); setSelectedCategory("all"); }} className="mt-3 text-sm font-semibold text-blue-600 hover:underline">Clear filters</button>}
      </div> : <>
        <div className="md:hidden space-y-3">{filtered.map((item) => <article key={item.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
          <div className="flex items-start justify-between gap-2"><div className="min-w-0"><h2 className="break-words text-sm font-bold text-slate-900">{item.name}</h2><p className="mt-1 text-xs text-slate-500">{item.supplier || "Supplier not entered"}</p></div>{actions(item)}</div>
          <div className="mt-4 flex items-end justify-between gap-2"><div><span className="text-xs text-slate-500">{item.category || "Uncategorized"}</span><p className="mt-1 text-[11px] text-slate-400">Updated {updatedLabel(item.lastUpdated)}</p></div><strong className={`text-sm font-mono ${unitCost(item) > 0 ? "text-slate-900" : "text-amber-700"}`}>{unitCost(item) > 0 ? `${formatCurrency(unitCost(item))} / ${item.unit}` : "Not priced"}</strong></div>
        </article>)}</div>
        <div className="hidden md:block rounded-xl border border-slate-200 bg-white shadow-xs overflow-x-auto"><table className="w-full min-w-[780px] text-left text-sm">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500"><tr><th className="px-5 py-3">Material</th><th className="px-4 py-3">Category</th><th className="px-4 py-3 text-right">Your unit cost</th><th className="px-4 py-3">Updated</th><th className="px-4 py-3 text-right">Actions</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{filtered.map((item) => <tr key={item.id} className="hover:bg-slate-50/70"><td className="px-5 py-4"><p className="font-semibold text-slate-900">{item.name}</p><p className="mt-1 text-xs text-slate-500">{item.supplier || "Supplier not entered"}</p></td><td className="px-4 py-4 text-xs text-slate-600">{item.category || "Uncategorized"}</td><td className={`px-4 py-4 text-right font-mono font-semibold whitespace-nowrap ${unitCost(item) > 0 ? "text-slate-900" : "text-amber-700"}`}>{unitCost(item) > 0 ? `${formatCurrency(unitCost(item))} / ${item.unit}` : "Not priced"}</td><td className="px-4 py-4 text-xs text-slate-500 whitespace-nowrap">{updatedLabel(item.lastUpdated)}</td><td className="px-4 py-4">{actions(item)}</td></tr>)}</tbody>
        </table></div>
        <p className="text-xs text-slate-500">{filtered.length} material{filtered.length === 1 ? "" : "s"} shown · {materials.filter((item) => unitCost(item) === 0).length} without a price</p>
      </>}
    </div>
  );
};
