import React, { useState } from "react";
import { Check, Database, Download, Lock, RefreshCw, ShieldCheck, Store, Upload } from "lucide-react";

type FeedStatus = "active" | "draft" | "licensed";

const priceFeeds: Array<{
  id: string;
  name: string;
  region: string;
  source: string;
  status: FeedStatus;
  items: string;
  updateCadence: string;
  description: string;
}> = [
  {
    id: "contractor-book",
    name: "Company Price Book",
    region: "Workspace default",
    source: "Imported supplier and labor rates",
    status: "active",
    items: "Editable",
    updateCadence: "Manual import",
    description: "Private unit costs, assemblies, markup defaults, and supplier notes owned by this workspace.",
  },
  {
    id: "new-england-public",
    name: "New England Public Benchmarks",
    region: "MA, RI, CT, NH, VT, ME",
    source: "DOT bids, BLS wages, state datasets",
    status: "draft",
    items: "Benchmark only",
    updateCadence: "Monthly review",
    description: "Reference ranges for civil/site work and labor context. Estimators approve before any value affects a client estimate.",
  },
  {
    id: "licensed-cost-data",
    name: "Licensed Cost Data Add-on",
    region: "City and regional cost indexes",
    source: "RSMeans/Gordian or approved provider",
    status: "licensed",
    items: "Provider gated",
    updateCadence: "Provider contract",
    description: "Paid marketplace integration for commercial-grade assemblies and regional factors once licensing is approved.",
  },
];

const stateCoverage = [
  { state: "MA", code: "780 CMR / 10th Edition", pricing: "MassDOT + BLS + private book" },
  { state: "RI", code: "510-RICR + ICC/NFPA references", pricing: "RIDOT + BLS + private book" },
  { state: "CT", code: "2022 Connecticut State Building Code", pricing: "CTDOT + BLS + private book" },
  { state: "NH", code: "State Building Code + local enforcement", pricing: "NHDOT + BLS + private book" },
  { state: "VT", code: "Vermont Fire & Building Safety Code", pricing: "VTrans + BLS + private book" },
  { state: "ME", code: "MUBEC + municipal enforcement", pricing: "MaineDOT + BLS + private book" },
];

export const PriceListsPage: React.FC = () => {
  const [activeListId, setActiveListId] = useState("contractor-book");

  const statusBadge = (status: FeedStatus) => {
    if (status === "active") return <span className="px-2 py-0.5 bg-emerald-50 text-emerald-700 rounded text-[10px] font-bold uppercase">Active</span>;
    if (status === "draft") return <span className="px-2 py-0.5 bg-amber-50 text-amber-700 rounded text-[10px] font-bold uppercase">Draft</span>;
    return <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded text-[10px] font-bold uppercase">Paid add-on</span>;
  };

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-7xl mx-auto space-y-6 select-none font-sans">
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-extrabold text-slate-900 tracking-tight">Price Marketplace</h1>
          <p className="text-[13px] text-slate-500 mt-0.5 max-w-2xl">
            Manage private price books, New England benchmarks, and licensed cost-data add-ons used by estimates.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="flex items-center gap-1.5 px-3.5 py-1.5 border border-slate-300 rounded-md text-[13px] font-medium text-slate-700 bg-white hover:bg-slate-50 transition shadow-2xs">
            <Upload className="w-4 h-4 text-slate-500" />
            <span>Import CSV</span>
          </button>
          <button className="flex items-center gap-1.5 px-3.5 py-1.5 border border-slate-300 rounded-md text-[13px] font-medium text-slate-700 bg-white hover:bg-slate-50 transition shadow-2xs">
            <RefreshCw className="w-4 h-4 text-slate-500" />
            <span>Sync Feeds</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {priceFeeds.map((feed) => {
          const isActive = activeListId === feed.id;
          return (
            <div key={feed.id} className={`p-5 rounded-lg border transition bg-white ${isActive ? "border-blue-400 shadow-xs" : "border-slate-200 hover:border-slate-300"}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="w-9 h-9 rounded-md bg-blue-50 text-blue-700 flex items-center justify-center shrink-0">
                  {feed.status === "licensed" ? <Lock className="w-4 h-4" /> : feed.status === "draft" ? <Store className="w-4 h-4" /> : <Database className="w-4 h-4" />}
                </div>
                {statusBadge(feed.status)}
              </div>
              <h3 className="text-[15px] font-bold text-slate-900 mt-4">{feed.name}</h3>
              <p className="text-[12px] text-slate-500 mt-1">{feed.region}</p>
              <p className="text-[13px] text-slate-600 mt-3 min-h-16">{feed.description}</p>
              <div className="mt-4 pt-3 border-t border-slate-200 space-y-2 text-[12px] text-slate-600">
                <div className="flex justify-between gap-3"><span>Source</span><strong className="text-slate-800 text-right">{feed.source}</strong></div>
                <div className="flex justify-between gap-3"><span>Items</span><strong className="text-slate-800">{feed.items}</strong></div>
                <div className="flex justify-between gap-3"><span>Updates</span><strong className="text-slate-800">{feed.updateCadence}</strong></div>
              </div>
              <button
                onClick={() => feed.status !== "licensed" && setActiveListId(feed.id)}
                disabled={feed.status === "licensed"}
                className={`mt-4 w-full flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-md text-[12.5px] font-semibold ${
                  isActive
                    ? "bg-emerald-50 text-emerald-700"
                    : feed.status === "licensed"
                    ? "bg-slate-100 text-slate-400"
                    : "bg-blue-600 text-white hover:bg-blue-700"
                }`}
              >
                {isActive ? <Check className="w-4 h-4" /> : feed.status === "licensed" ? <Lock className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />}
                <span>{isActive ? "Active in estimates" : feed.status === "licensed" ? "Requires license approval" : "Set as active benchmark"}</span>
              </button>
            </div>
          );
        })}
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-slate-900">New England Coverage</h2>
            <p className="text-xs text-slate-500 mt-0.5">Code references are metadata and source links; RoughBid does not certify compliance.</p>
          </div>
          <button className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-slate-300 rounded-md text-slate-700">
            <Download className="w-3.5 h-3.5" />
            Export
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider">
              <tr>
                <th className="px-5 py-3 font-bold">State</th>
                <th className="px-5 py-3 font-bold">Code Reference</th>
                <th className="px-5 py-3 font-bold">Pricing Inputs</th>
                <th className="px-5 py-3 font-bold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {stateCoverage.map((row) => (
                <tr key={row.state}>
                  <td className="px-5 py-3 font-bold text-slate-900">{row.state}</td>
                  <td className="px-5 py-3 text-slate-600">{row.code}</td>
                  <td className="px-5 py-3 text-slate-600">{row.pricing}</td>
                  <td className="px-5 py-3"><span className="px-2 py-0.5 rounded bg-amber-50 text-amber-700 font-bold uppercase">Source review</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
