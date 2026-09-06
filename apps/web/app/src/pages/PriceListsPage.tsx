import React from 'react';
import { Database, Download, ArrowRight, Boxes, Package } from 'lucide-react';
import { StorageService, type StorageScope } from '../utils/storage';
import { formatCurrency } from '../utils/calculations';

function csvCell(value: string | number) {
  let text = String(value);
  if (/^[=+@\-\t\r]/.test(text) && typeof value !== 'number') text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export const PriceListsPage: React.FC<{ scope: StorageScope; onOpenMaterials: () => void }> = ({scope,onOpenMaterials}) => {
  const materials = StorageService.getMaterials(scope);
  const assemblies = StorageService.getAssemblies(scope);
  const exportBook = () => {
    const rows = [['Name','Category','Unit','Unit cost','Supplier','Updated'], ...materials.map(item=>[item.name,item.category,item.unit,item.unitCost ?? item.unitPrice ?? 0,item.supplier ?? '',item.lastUpdated])];
    const blob = new Blob(['\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob); const link=document.createElement('a'); link.href=url;link.download='RoughBid-company-price-book.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  return <div className="p-4 sm:p-8 max-w-6xl mx-auto space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs uppercase tracking-wider font-bold text-blue-600">Your estimating library</p><h1 className="text-2xl font-bold text-slate-900 mt-1">Company price book</h1><p className="text-sm text-slate-500 mt-2 max-w-xl">The material rates and assemblies you entered. Check supplier quotes and dates before using a price in a bid.</p></div><button disabled={!materials.length} onClick={exportBook} className="inline-flex gap-2 items-center rounded-lg border bg-white px-4 py-2 text-sm font-semibold disabled:opacity-40"><Download className="size-4"/>Export material CSV</button></header>
    <div className="grid sm:grid-cols-2 gap-4">{[{label:'Material rates',count:materials.length,Icon:Package},{label:'Assemblies',count:assemblies.length,Icon:Boxes}].map(({label,count,Icon})=><div key={label} className="p-5 bg-white border border-slate-200 rounded-xl"><Icon className="size-5 text-blue-600"/><p className="text-sm text-slate-500 mt-3">{label}</p><strong className="text-3xl font-bold">{count}</strong></div>)}</div>
    <section className="rounded-xl border border-slate-200 bg-white overflow-hidden"><div className="p-5 flex justify-between items-center gap-3 border-b border-slate-100"><h2 className="font-bold">Material unit costs</h2><button onClick={onOpenMaterials} className="flex items-center gap-1 text-sm font-semibold text-blue-600">Manage materials<ArrowRight className="size-4"/></button></div>
    {materials.length ? <div className="divide-y divide-slate-100">{materials.map(item=><div key={item.id} className="px-5 py-4 flex gap-4 justify-between"><div className="min-w-0"><p className="font-semibold text-sm break-words">{item.name}</p><p className="text-xs text-slate-500 mt-1">{item.supplier || 'Supplier not entered'} · {item.lastUpdated}</p></div><span className="font-mono text-sm whitespace-nowrap">{formatCurrency(item.unitCost ?? item.unitPrice ?? 0)} / {item.unit}</span></div>)}</div> : <div className="text-center p-10"><Database className="size-8 text-slate-300 mx-auto"/><h3 className="font-semibold mt-3">Build your own price book</h3><p className="text-sm text-slate-500 mt-2">Add your supplier prices in Materials to see them here.</p><button onClick={onOpenMaterials} className="mt-4 rounded-lg bg-blue-600 text-white px-4 py-2 text-sm font-semibold">Add material rates</button></div>}
    </section><p className="text-xs text-slate-500">Library data is saved in this browser for your account and workspace. Export a CSV backup before changing devices. External price feeds are not connected.</p>
  </div>;
};
