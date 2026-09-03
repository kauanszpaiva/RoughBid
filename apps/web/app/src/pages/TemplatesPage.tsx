import React from "react";
import { Compass, Plus, ArrowRight, FolderPlus, Layers } from "lucide-react";
import { Project } from "../types";

interface TemplatesPageProps {
  onUseTemplate: (templateName: string) => void;
}

export const TemplatesPage: React.FC<TemplatesPageProps> = ({ onUseTemplate }) => {
  const templates = [
    {
      id: "tpl-deck",
      name: "Custom Residential Deck Renovation",
      category: "Exterior Carpentry",
      tradesCount: 4,
      itemsCount: 12,
      typicalMargin: "18.5%",
      description: "Complete takeoff template covering deck footings, PT framing, composite decking, perimeter railing, and LED stair lighting.",
    },
    {
      id: "tpl-kitchen",
      name: "Full Kitchen Remodel & Island Addition",
      category: "Interior Remodel",
      tradesCount: 6,
      itemsCount: 22,
      typicalMargin: "22.0%",
      description: "Demolition, custom cabinetry, quartz countertops, plumbing fixtures, tile backsplash, and recessed lighting package.",
    },
    {
      id: "tpl-drywall",
      name: "Commercial Tenant Drywall & Paint Package",
      category: "Commercial Finishes",
      tradesCount: 3,
      itemsCount: 8,
      typicalMargin: "15.0%",
      description: "Metal stud framing, 5/8 Type X drywall, Level 4 finishing, prime coat, and two coats low-VOC acrylic paint.",
    },
    {
      id: "tpl-bath",
      name: "Master Bathroom Addition & Tile Package",
      category: "Interior Remodel",
      tradesCount: 5,
      itemsCount: 16,
      typicalMargin: "20.0%",
      description: "Schluter shower waterproofing, porcelain floor tile, double vanity plumbing rough-in, and glass shower enclosure.",
    },
  ];

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6 select-none font-sans">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[22px] font-extrabold text-slate-900 tracking-tight">
            Estimate Templates
          </h1>
          <p className="text-[13px] text-slate-500 mt-0.5">
            Pre-assembled takeoff and estimate frameworks to accelerate new bid production.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {templates.map((tpl) => (
          <div
            key={tpl.id}
            className="bg-white border border-slate-200 rounded-xl p-5 hover:border-blue-400 shadow-xs transition flex flex-col justify-between space-y-3"
          >
            <div>
              <span className="text-[10.5px] font-bold uppercase tracking-wider bg-slate-100 text-slate-700 px-2 py-0.5 rounded">
                {tpl.category}
              </span>
              <h3 className="text-[16px] font-bold text-slate-900 mt-1.5">
                {tpl.name}
              </h3>
              <p className="text-[12.5px] text-slate-500 mt-1 leading-relaxed">
                {tpl.description}
              </p>
            </div>

            <div className="pt-3 border-t border-slate-100 flex items-center justify-between">
              <span className="text-[12px] text-slate-600">
                {tpl.itemsCount} Items • Avg. Margin: <strong className="text-emerald-700 font-bold">{tpl.typicalMargin}</strong>
              </span>

              <button
                onClick={() => onUseTemplate(tpl.name)}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-[12px] font-semibold flex items-center gap-1 shadow-2xs cursor-pointer"
              >
                <span>Use Template</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
