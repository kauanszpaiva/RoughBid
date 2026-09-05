import React, { useState } from "react";
import { Boxes, Plus, Search, ChevronRight, Layers, DollarSign } from "lucide-react";
import { formatCurrency } from "../utils/calculations";

interface Assembly {
  id: string;
  code: string;
  name: string;
  trade: string;
  unit: string;
  unitCost: number;
  componentsCount: number;
  description: string;
}

export const AssembliesPage: React.FC = () => {
  const [assemblies] = useState<Assembly[]>([
    {
      id: "asm-1",
      code: "ASM-09-001",
      name: '5/8" Drywall Partition Assembly (Level 4 Finish)',
      trade: "Finishes",
      unit: "SF",
      unitCost: 2.80,
      componentsCount: 4,
      description: 'Includes 5/8" drywall boards, joint compound, paper tape, drywall screws, and primer prep.',
    },
    {
      id: "asm-2",
      code: "ASM-06-002",
      name: '2x8 Pressure Treated Deck Framing System (16" O.C.)',
      trade: "Framing",
      unit: "SF",
      unitCost: 9.45,
      componentsCount: 6,
      description: "Includes ledger attachment, Simpson joist hangers, PT framing, blocking, and ledger flashing.",
    },
    {
      id: "asm-3",
      code: "ASM-06-003",
      name: "TimberTech Composite Decking Board Installation",
      trade: "Finishes",
      unit: "SF",
      unitCost: 11.20,
      componentsCount: 3,
      description: "Includes composite planks, CONCEALoc hidden fasteners, and perimeter end clips.",
    },
    {
      id: "asm-4",
      code: "ASM-03-001",
      name: '12" Round Concrete Pier Footing (48" Below Grade)',
      trade: "Concrete",
      unit: "EA",
      unitCost: 320.00,
      componentsCount: 5,
      description: "Sonotube form, rebar cage #4, 4000 PSI concrete pour, anchor bolts, and post saddle.",
    },
  ]);

  const [search, setSearch] = useState("");

  const filtered = assemblies.filter(
    (a) =>
      a.name.toLowerCase().includes(search.toLowerCase()) ||
      a.code.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6 select-none font-sans">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[22px] font-extrabold text-slate-900 tracking-tight">
            Assemblies
          </h1>
          <p className="text-[13px] text-slate-500 mt-0.5">
            Compound multi-component systems combining material, labor, and equipment into standard unit rates.
          </p>
        </div>

        <button
          onClick={() => alert("Assemblies builder opened.")}
          className="flex items-center gap-1.5 px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-[13px] font-semibold transition shadow-xs"
        >
          <Plus className="w-4 h-4" />
          <span>New Assembly</span>
        </button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
        <input
          type="text"
          placeholder="Search pre-configured construction assemblies..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-3 py-2 pl-9 border border-slate-300 rounded-md text-[13px] bg-white"
        />
      </div>

      {/* Assembly Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filtered.map((asm) => (
          <div
            key={asm.id}
            className="bg-white border border-slate-200 rounded-xl p-5 hover:border-blue-400 shadow-xs transition space-y-3"
          >
            <div className="flex items-start justify-between">
              <div>
                <span className="text-[10.5px] font-mono font-bold bg-slate-100 text-slate-700 px-2 py-0.5 rounded">
                  {asm.code}
                </span>
                <h3 className="text-[15px] font-bold text-slate-900 mt-1.5">
                  {asm.name}
                </h3>
              </div>
              <div className="text-right">
                <span className="text-[11px] text-slate-400 uppercase font-bold block">Unit Rate</span>
                <span className="text-[16px] font-extrabold text-slate-900 font-mono">
                  {formatCurrency(asm.unitCost)} / {asm.unit}
                </span>
              </div>
            </div>

            <p className="text-[12.5px] text-slate-500 leading-relaxed">
              {asm.description}
            </p>

            <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-[12px]">
              <span className="text-slate-600 font-medium">
                Trade: <strong className="text-slate-800">{asm.trade}</strong> ({asm.componentsCount} linked items)
              </span>
              <button
                onClick={() => alert(`Assembly ${asm.code} components loaded`)}
                className="text-blue-600 font-bold hover:underline flex items-center gap-1"
              >
                <span>View Recipe</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
