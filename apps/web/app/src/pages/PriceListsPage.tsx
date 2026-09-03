import React, { useState } from "react";
import { Receipt, Check, Download, RefreshCw, Layers, ShieldCheck } from "lucide-react";

export const PriceListsPage: React.FC = () => {
  const [activeListId, setActiveListId] = useState("pl-1");

  const priceLists = [
    {
      id: "pl-1",
      name: "Prime Bid Master Price Book (Q3 2026)",
      region: "North America - National Average",
      itemsCount: 4250,
      accuracy: "99.2%",
      lastSync: "Sep 01, 2026",
      isDefault: true,
      description: "Standard RSMeans-aligned contractor price index updated bi-weekly with prevailing trade labor and material indexes.",
    },
    {
      id: "pl-2",
      name: "West Coast Metro (Zone 1)",
      region: "California, Oregon, Washington",
      itemsCount: 3890,
      accuracy: "98.7%",
      lastSync: "Aug 28, 2026",
      isDefault: false,
      description: "Indexed for elevated urban labor rates, Title 24 energy mandates, and seismic strapping hardware.",
    },
    {
      id: "pl-3",
      name: "Residential Remodel & Custom Decks 2026",
      region: "Midwest & Central",
      itemsCount: 1650,
      accuracy: "99.0%",
      lastSync: "Aug 15, 2026",
      isDefault: false,
      description: "Specialized for residential renovations, high-end millwork, outdoor living, and kitchen carpentry.",
    },
  ];

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6 select-none font-sans">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[22px] font-extrabold text-slate-900 tracking-tight">
            Price Lists
          </h1>
          <p className="text-[13px] text-slate-500 mt-0.5">
            Regional pricing databases and active estimating catalogs.
          </p>
        </div>

        <button
          onClick={() => alert("Checking for latest Prime Bid price updates...")}
          className="flex items-center gap-1.5 px-3.5 py-1.5 border border-slate-300 rounded-md text-[13px] font-medium text-slate-700 bg-white hover:bg-slate-50 transition shadow-2xs"
        >
          <RefreshCw className="w-4 h-4 text-slate-500" />
          <span>Sync Price Updates</span>
        </button>
      </div>

      <div className="space-y-4">
        {priceLists.map((pl) => {
          const isActive = activeListId === pl.id;

          return (
            <div
              key={pl.id}
              className={`p-5 rounded-xl border transition ${
                isActive
                  ? "bg-blue-50/40 border-blue-400 shadow-xs"
                  : "bg-white border-slate-200 hover:border-slate-300"
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-[16px] font-bold text-slate-900">
                      {pl.name}
                    </h3>
                    {isActive && (
                      <span className="px-2 py-0.5 bg-blue-600 text-white rounded text-[10.5px] font-bold">
                        ACTIVE IN ESTIMATES
                      </span>
                    )}
                  </div>
                  <p className="text-[12px] text-slate-500 mt-1">
                    Region: <strong className="text-slate-700">{pl.region}</strong> • {pl.itemsCount.toLocaleString()} items indexed • Last synced {pl.lastSync}
                  </p>
                </div>

                <div>
                  {isActive ? (
                    <div className="flex items-center gap-1 text-emerald-600 text-[12px] font-bold bg-emerald-50 px-3 py-1 rounded">
                      <ShieldCheck className="w-4 h-4" />
                      <span>In Use</span>
                    </div>
                  ) : (
                    <button
                      onClick={() => setActiveListId(pl.id)}
                      className="px-3.5 py-1.5 bg-white border border-slate-300 hover:bg-slate-100 rounded text-[12.5px] font-semibold text-slate-700"
                    >
                      Set as Active
                    </button>
                  )}
                </div>
              </div>

              <p className="text-[13px] text-slate-600 mt-3 pt-3 border-t border-slate-200/80">
                {pl.description}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
};
