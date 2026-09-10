import React from 'react';
import { AlertCircle, ArrowRight, Boxes, Check, Database, Download, Loader2, Package, ShoppingBag, Upload } from 'lucide-react';
import { createBillingCheckout, getMarketplaceCatalog, type MarketplaceCatalog } from '../services/api';
import { StorageService, type StorageScope } from '../utils/storage';
import { formatCurrency } from '../utils/calculations';
import { parseSupplierPriceCsv, SUPPLIER_CSV_TEMPLATE } from '../utils/supplierPriceImport';

function csvCell(value: string | number) {
  let text = String(value);
  if (/^[=+@\-\t\r]/.test(text) && typeof value !== 'number') text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
function download(name:string,body:string){const blob=new Blob(['\uFEFF'+body],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

export const PriceListsPage: React.FC<{ scope: StorageScope; canWrite?:boolean; onOpenMaterials: () => void }> = ({scope,canWrite=false,onOpenMaterials}) => {
  const [materials,setMaterials]=React.useState(()=>StorageService.getMaterials(scope));
  const [catalog,setCatalog]=React.useState<MarketplaceCatalog|null>(null);
  const [error,setError]=React.useState('');const [notice,setNotice]=React.useState('');const [busy,setBusy]=React.useState(false);
  const fileInput=React.useRef<HTMLInputElement>(null);
  React.useEffect(()=>{let active=true;setMaterials(StorageService.getMaterials(scope));setCatalog(null);setError('');setNotice('');
    getMarketplaceCatalog(scope.workspaceId).then(value=>{if(active)setCatalog(value);}).catch(e=>{if(active)setError(e instanceof Error?e.message:'Marketplace access could not be verified.');});
    return()=>{active=false;};},[scope.userId,scope.workspaceId]);
  const assemblies = StorageService.getAssemblies(scope);
  const supplier=catalog?.items.find(item=>item.id==='supplier_import');
  const exportBook = () => download('RoughBid-company-price-book.csv', [['Name','Category','Unit','Unit cost','Supplier','Updated'], ...materials.map(item=>[item.name,item.category,item.unit,item.unitCost ?? item.unitPrice ?? 0,item.supplier ?? '',item.lastUpdated])].map(row=>row.map(csvCell).join(',')).join('\r\n'));
  const checkout=async()=>{if(!supplier?.checkoutAvailable||busy)return;setBusy(true);setError('');try{window.location.assign((await createBillingCheckout(supplier.priceKey,scope.workspaceId)).url);}catch(e){setError(e instanceof Error?e.message:'Marketplace checkout is unavailable.');setBusy(false);}};
  const importCsv=async(event:React.ChangeEvent<HTMLInputElement>)=>{const file=event.target.files?.[0];event.target.value='';if(!file||!supplier?.entitled||!canWrite)return;
    if(file.size>2*1024*1024){setError('Supplier CSV is limited to 2 MB.');return;}setBusy(true);setError('');setNotice('');
    try{const imported=parseSupplierPriceCsv(await file.text());const identities=new Set(imported.map(item=>`${item.name.toLowerCase()}\n${(item.supplier??'').toLowerCase()}\n${item.unit}`));
      const updated=[...imported,...materials.filter(item=>!identities.has(`${item.name.toLowerCase()}\n${(item.supplier??'').toLowerCase()}\n${item.unit}`))];
      if(!StorageService.saveMaterials(updated,scope))throw new Error('This browser could not save the imported price list.');setMaterials(updated);setNotice(`${imported.length} supplier price${imported.length===1?'':'s'} imported. Review dates and costs before using them in a bid.`);
    }catch(e){setError(e instanceof Error?e.message:'Supplier CSV could not be imported.');}finally{setBusy(false);}};
  return <div className="p-4 sm:p-8 max-w-6xl mx-auto space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs uppercase tracking-wider font-bold text-blue-600">Your estimating library</p><h1 className="text-2xl font-bold text-slate-900 mt-1">Price book & Marketplace</h1><p className="text-sm text-slate-500 mt-2 max-w-2xl">Manage your company rates and optional RoughBid tools. Imported prices remain estimator-entered data—not verified bids or supplier guarantees.</p></div><button disabled={!materials.length} onClick={exportBook} className="inline-flex gap-2 items-center rounded-lg border bg-white px-4 py-2 text-sm font-semibold disabled:opacity-40"><Download className="size-4"/>Export material CSV</button></header>
    {error&&<p role="alert" className="flex gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"><AlertCircle className="size-4 shrink-0 mt-0.5"/>{error}</p>}
    {notice&&<p role="status" className="flex gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"><Check className="size-4 shrink-0 mt-0.5"/>{notice}</p>}
    <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4"><div className="flex gap-3 items-start"><ShoppingBag className="size-6 text-blue-600 shrink-0"/><div><h2 className="font-bold">RoughBid Marketplace</h2><p className="text-sm text-slate-600 mt-1">Add-on access is verified from Stripe and scoped to this workspace. A return from Checkout alone never unlocks it.</p></div></div>
      {!catalog?<p role="status" className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="size-4 animate-spin"/>Checking Marketplace access…</p>:<div className="grid md:grid-cols-2 gap-3">{catalog.items.map(item=><article key={item.id} className="rounded-lg border border-slate-200 p-4"><div className="flex justify-between gap-3"><div><h3 className="font-semibold">{item.name}</h3><p className="text-sm text-slate-600 mt-1">{item.description}</p></div><span className="font-mono text-sm whitespace-nowrap">{formatCurrency(item.priceCents/100)}/mo</span></div>
        {item.id==='supplier_import'&&<div className="mt-4 flex flex-wrap gap-2">{item.entitled?<><button disabled={!canWrite||busy} onClick={()=>fileInput.current?.click()} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 text-white px-3 py-2 text-sm font-semibold disabled:opacity-40"><Upload className="size-4"/>{canWrite?'Import supplier CSV':'View-only access'}</button><button onClick={()=>download('RoughBid-supplier-import-template.csv',SUPPLIER_CSV_TEMPLATE)} className="rounded-lg border px-3 py-2 text-sm font-semibold">Download template</button><input ref={fileInput} className="hidden" type="file" accept=".csv,text/csv" onChange={importCsv}/></>:item.checkoutAvailable?<button disabled={busy} onClick={checkout} className="rounded-lg bg-blue-600 text-white px-3 py-2 text-sm font-semibold disabled:opacity-40">{busy?'Opening secure checkout…':'Subscribe in Stripe'}</button>:<span className="text-xs font-semibold text-slate-500">{item.availability==='coming_soon'?'Coming soon':'Contact a workspace administrator'}</span>}</div>}
        {item.id!=='supplier_import'&&<p className="mt-4 text-xs font-semibold text-slate-500">Coming soon — no checkout is offered.</p>}
      </article>)}</div>}
      {catalog&&<p className="text-xs text-slate-500">Marketplace pricing policy {catalog.pricingVersion}. Supplier Price Import renews monthly until canceled in the Stripe billing portal. For billing help, email <a className="underline" href="mailto:hello@kspdominion.group">hello@kspdominion.group</a>.</p>}
    </section>
    <div className="grid sm:grid-cols-2 gap-4">{[{label:'Material rates',count:materials.length,Icon:Package},{label:'Assemblies',count:assemblies.length,Icon:Boxes}].map(({label,count,Icon})=><div key={label} className="p-5 bg-white border border-slate-200 rounded-xl"><Icon className="size-5 text-blue-600"/><p className="text-sm text-slate-500 mt-3">{label}</p><strong className="text-3xl font-bold">{count}</strong></div>)}</div>
    <section className="rounded-xl border border-slate-200 bg-white overflow-hidden"><div className="p-5 flex justify-between items-center gap-3 border-b border-slate-100"><h2 className="font-bold">Material unit costs</h2><button onClick={onOpenMaterials} className="flex items-center gap-1 text-sm font-semibold text-blue-600">Manage materials<ArrowRight className="size-4"/></button></div>
    {materials.length ? <div className="divide-y divide-slate-100">{materials.map(item=><div key={item.id} className="px-5 py-4 flex gap-4 justify-between"><div className="min-w-0"><p className="font-semibold text-sm break-words">{item.name}</p><p className="text-xs text-slate-500 mt-1">{item.supplier || 'Supplier not entered'} · {new Date(item.lastUpdated).toLocaleDateString()}</p></div><span className="font-mono text-sm whitespace-nowrap">{formatCurrency(item.unitCost ?? item.unitPrice ?? 0)} / {item.unit}</span></div>)}</div> : <div className="text-center p-10"><Database className="size-8 text-slate-300 mx-auto"/><h3 className="font-semibold mt-3">Build your own price book</h3><p className="text-sm text-slate-500 mt-2">Add your supplier prices in Materials or use an entitled supplier CSV import.</p><button onClick={onOpenMaterials} className="mt-4 rounded-lg bg-blue-600 text-white px-4 py-2 text-sm font-semibold">Add material rates</button></div>}
    </section><p className="text-xs text-slate-500">Company library data is saved in this browser for your account and workspace. Export a CSV backup before changing devices. Always confirm supplier quotes, effective dates, taxes, delivery, and local requirements.</p>
  </div>;
};
