import React, { useState } from "react";
import { Search, Plus, Filter, Layers, Edit2, Trash2, Check, Tag } from "lucide-react";
import { MaterialItem, UnitType } from "../types";
import { formatCurrency } from "../utils/calculations";

export const MaterialsPage: React.FC = () => {
  const [materials, setMaterials] = useState<MaterialItem[]>([
    { id: "mat-1", name: '5/8" Firecode Gypsum Board (4x8)', category: "Drywall", unit: "SF", unitCost: 0.75, supplier: "USG Direct", lastUpdated: "Aug 20, 2026" },
    { id: "mat-2", name: '1/2" Standard Drywall (4x12)', category: "Drywall", unit: "SF", unitCost: 0.58, supplier: "National Gypsum", lastUpdated: "Aug 15, 2026" },
    { id: "mat-3", name: '2x6x16 #2 Pressure Treated SYP', category: "Lumber", unit: "LF", unitCost: 1.85, supplier: "Builders FirstSource", lastUpdated: "Sep 01, 2026" },
    { id: "mat-4", name: '2x8x16 Hem-Fir Floor Joist', category: "Lumber", unit: "LF", unitCost: 2.10, supplier: "Builders FirstSource", lastUpdated: "Aug 28, 2026" },
    { id: "mat-5", name: 'TimberTech Composite Decking Board 16ft', category: "Finishes", unit: "SF", unitCost: 5.40, supplier: "AZEK Building Products", lastUpdated: "Aug 12, 2026" },
    { id: "mat-6", name: '4,000 PSI Ready-Mix Concrete', category: "Concrete", unit: "CY", unitCost: 165.00, supplier: "Cemex Materials", lastUpdated: "Aug 30, 2026" },
    { id: "mat-7", name: 'Sherwin-Williams ProMar 200 Interior Latex', category: "Paint", unit: "SF", unitCost: 0.35, supplier: "Sherwin-Williams", lastUpdated: "Jul 22, 2026" },
    { id: "mat-8", name: '5-1/4" MDF Primed Baseboard Molding', category: "Millwork", unit: "LF", unitCost: 1.45, supplier: "Metrie Millwork", lastUpdated: "Aug 18, 2026" },
  ]);

  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCat, setNewCat] = useState("Lumber");
  const [newUnit, setNewUnit] = useState<UnitType>("SF");
  const [newCost, setNewCost] = useState(1.5);
  const [newSupplier, setNewSupplier] = useState("Prime Supply");

  const categories = ["all", "Drywall", "Lumber", "Finishes", "Concrete", "Paint", "Millwork"];

  const filtered = materials.filter((m) => {
    const matchSearch = m.name.toLowerCase().includes(search.toLowerCase()) || m.supplier?.toLowerCase().includes(search.toLowerCase());
    const matchCat = selectedCategory === "all" || m.category === selectedCategory;
    return matchSearch && matchCat;
  });

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    const item: MaterialItem = {
      id: `mat-${Date.now()}`,
      name: newName.trim(),
      category: newCat,
      unit: newUnit,
      unitCost: Number(newCost) || 0,
      supplier: newSupplier.trim(),
      lastUpdated: "Just now",
    };
    setMaterials([item, ...materials]);
    setNewName("");
    setIsAdding(false);
  };

  const handleDelete = (id: string) => {
    setMaterials(materials.filter((m) => m.id !== id));
  };

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6 select-none font-sans">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[22px] font-extrabold text-slate-900 tracking-tight">
            Materials Library
          </h1>
          <p className="text-[13px] text-slate-500 mt-0.5">
            Manage unit prices, supplier price books, and cost catalogs.
          </p>
        </div>

        <button
          onClick={() => setIsAdding(true)}
          className="flex items-center gap-1.5 px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-[13px] font-semibold transition shadow-xs"
        >
          <Plus className="w-4 h-4" />
          <span>New Material</span>
        </button>
      </div>

      {/* Filter & Search Bar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
          <input
            type="text"
            placeholder="Search material catalog by description or supplier..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-3 py-2 pl-9 border border-slate-300 rounded-md text-[13px] bg-white"
          />
        </div>

        <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-md p-1">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`px-3 py-1 rounded text-[12px] font-medium transition capitalize ${
                selectedCategory === cat
                  ? "bg-blue-600 text-white font-semibold shadow-2xs"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Add New Material Modal/Inline */}
      {isAdding && (
        <form
          onSubmit={handleAdd}
          className="p-4 bg-blue-50 border border-blue-200 rounded-lg space-y-3"
        >
          <h3 className="text-[13px] font-bold text-blue-900">Add Material to Price Catalog</h3>
          <div className="grid grid-cols-5 gap-3 text-[12px]">
            <div className="col-span-2">
              <label className="block text-slate-600 mb-1">Description</label>
              <input
                type="text"
                placeholder="e.g. 2x4 SPF Stud 92-5/8"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded"
                required
              />
            </div>
            <div>
              <label className="block text-slate-600 mb-1">Category</label>
              <select
                value={newCat}
                onChange={(e) => setNewCat(e.target.value)}
                className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded"
              >
                {categories.filter((c) => c !== "all").map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-slate-600 mb-1">Unit Cost ($)</label>
              <input
                type="number"
                step="0.01"
                value={newCost}
                onChange={(e) => setNewCost(Number(e.target.value))}
                className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block text-slate-600 mb-1">Supplier</label>
              <input
                type="text"
                value={newSupplier}
                onChange={(e) => setNewSupplier(e.target.value)}
                className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setIsAdding(false)}
              className="px-3 py-1 text-slate-600 text-[12px]"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1 bg-blue-600 text-white rounded text-[12px] font-bold"
            >
              Save to Catalog
            </button>
          </div>
        </form>
      )}

      {/* Materials Table */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden shadow-xs">
        <table className="w-full text-left text-[13px]">
          <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-bold text-[11px] uppercase tracking-wider">
            <tr>
              <th className="py-3 px-4">ITEM DESCRIPTION</th>
              <th className="py-3 px-4">CATEGORY</th>
              <th className="py-3 px-4 text-center">UNIT</th>
              <th className="py-3 px-4 text-right">UNIT PRICE</th>
              <th className="py-3 px-4">PREFERRED SUPPLIER</th>
              <th className="py-3 px-4">UPDATED</th>
              <th className="py-3 px-4 text-right">ACTION</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((mat) => (
              <tr key={mat.id} className="hover:bg-slate-50/70 transition">
                <td className="py-3 px-4 font-semibold text-slate-900">{mat.name}</td>
                <td className="py-3 px-4">
                  <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-[11px] font-medium">
                    {mat.category}
                  </span>
                </td>
                <td className="py-3 px-4 text-center font-mono font-bold text-slate-600">{mat.unit}</td>
                <td className="py-3 px-4 text-right font-mono font-bold text-slate-900">
                  {formatCurrency(mat.unitCost ?? mat.unitPrice ?? 0)}
                </td>
                <td className="py-3 px-4 text-slate-600">{mat.supplier}</td>
                <td className="py-3 px-4 text-slate-400 text-[11px]">{mat.lastUpdated}</td>
                <td className="py-3 px-4 text-right">
                  <button
                    onClick={() => handleDelete(mat.id)}
                    className="p-1 text-slate-300 hover:text-rose-600 transition"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
