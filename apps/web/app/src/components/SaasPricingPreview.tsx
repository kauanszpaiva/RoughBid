import React, { useId, useState } from 'react';
import {
  calculateSaasPricingDraft, createSaasCostDraft, createSaasPricingDraft,
  exportSaasPricingPreview, SAAS_PROJECT_MARGIN_POLICY,
  type ProjectMembership, type SaasCostBasis, type SaasCostDraft, type SaasCostDriver, type SaasPricingDraft,
} from '../services/saasPricing';

const dollars = (cents: number | null) => cents === null ? 'Pending' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const microDollars = (amount: number | null) => amount === null ? 'Pending' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }).format(amount / 1_000_000);
const fieldClass = 'mt-1 block w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 focus-visible:outline-2 focus-visible:outline-blue-600';

/** The verified platform-owner page supplies this flag. This simulator reads no private server data. */
export function SaasPricingPreview({ isPlatformAdmin }: { isPlatformAdmin: boolean }) {
  const prefix = useId();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<SaasPricingDraft['kind']>('per_document');
  const [documentDraft, setDocumentDraft] = useState(() => createSaasPricingDraft('per_document'));
  const [monthlyDraft, setMonthlyDraft] = useState(() => createSaasPricingDraft('monthly_membership'));
  const [nextId, setNextId] = useState(2);
  const [auditVisible, setAuditVisible] = useState(false);
  if (!isPlatformAdmin) return null;
  const draft = mode === 'per_document' ? documentDraft : monthlyDraft;
  const result = calculateSaasPricingDraft(draft);
  const setDraft = (update: (current: SaasPricingDraft) => SaasPricingDraft) => mode === 'per_document' ? setDocumentDraft(update) : setMonthlyDraft(update);
  const updateDraft = <K extends keyof SaasPricingDraft>(key: K, value: SaasPricingDraft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const updateCost = <K extends keyof SaasCostDraft>(id: string, key: K, value: SaasCostDraft[K]) => setDraft(current => ({ ...current, costs: current.costs.map(row => row.id === id ? { ...row, [key]: value } : row) }));
  const removeCost = (id: string) => setDraft(current => ({ ...current, costs: current.costs.filter(row => row.id !== id) }));
  const addCost = () => { setDraft(current => ({ ...current, costs: [...current.costs, createSaasCostDraft(`${mode}-${nextId}`)] })); setNextId(value => value + 1); };
  const input = (label: string, key: 'fixedPaymentUsd' | 'paymentPercent' | 'paymentSource' | 'monthlyMarginPercent' | 'monthlyMarginSource' | 'monthlyMarginVersion', decimal = false) => <label className="block text-sm font-medium">{label}<input className={fieldClass} inputMode={decimal ? 'decimal' : 'text'} value={draft[key]} onChange={event => updateDraft(key, event.target.value)} /></label>;

  return <section aria-label="Owner RoughBid service pricing preview" className="rounded-xl border border-slate-300 bg-white overflow-hidden">
    <button type="button" className="w-full p-5 text-left flex justify-between gap-3 bg-slate-950 text-white focus-visible:outline-4 focus-visible:outline-blue-500" aria-expanded={open} aria-controls={`${prefix}-pricing`} onClick={() => setOpen(value => !value)}><span><strong className="block">RoughBid service pricing preview</strong><span className="text-xs text-slate-300">Owner calculation for monthly membership and each document</span></span><span>{open ? 'Close' : 'Open'}</span></button>
    {open && <div id={`${prefix}-pricing`} className="p-4 sm:p-6 space-y-5">
      <p className="text-sm text-slate-600">This preview calculates the RoughBid service fee. The construction estimate has its own materials, labor and equipment. No checkout, subscription, provider call or charge starts here.</p>
      <fieldset className="flex flex-wrap gap-4"><legend className="mb-2 font-semibold">Price to review</legend>{(['per_document', 'monthly_membership'] as const).map(value => <label key={value} className="flex items-center gap-2 text-sm"><input type="radio" name={`${prefix}-mode`} value={value} checked={mode === value} onChange={() => { setMode(value); setAuditVisible(false); }} />{value === 'per_document' ? 'Per document' : 'Monthly membership'}</label>)}</fieldset>
      {mode === 'per_document' ? <div className="grid sm:grid-cols-2 gap-4"><label className="text-sm font-medium">Customer membership<select className={fieldClass} value={draft.membership} onChange={event => updateDraft('membership', event.target.value as ProjectMembership)}>{Object.keys(SAAS_PROJECT_MARGIN_POLICY.marginsBps).map(value => <option key={value} value={value}>{value === 'standard' ? 'No membership' : value[0]!.toUpperCase() + value.slice(1)}</option>)}</select></label><p className="text-sm self-end py-2">Project-reading target margin: {(SAAS_PROJECT_MARGIN_POLICY.marginsBps[draft.membership] / 100).toFixed(0)}%. This is margin after technical and payment costs.</p></div> : <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 space-y-3"><p className="text-sm text-amber-950">Monthly prices and target margins are pending in the primary business policy. Enter a sourced planning parameter to simulate a proposal; this does not approve a sellable price.</p><div className="grid sm:grid-cols-3 gap-3">{input('Monthly target margin (%)', 'monthlyMarginPercent', true)}{input('Margin source / decision reference', 'monthlyMarginSource')}{input('Margin policy version', 'monthlyMarginVersion')}</div><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={draft.membershipAllocationConfirmed} onChange={event => updateDraft('membershipAllocationConfirmed', event.target.checked)} className="mt-1" /><span>These are membership operating costs only. Project reads are billed separately; this does not include unlimited processing.</span></label></div>}
      <div className="space-y-3"><h3 className="font-semibold">Documented technical costs</h3><p className="text-sm text-slate-600">Use the actual pages, regions and approved stage calls for each document, or their measured cost. A forecast must include applicable providers and failed attempts. Do not count the same cost twice as both usage and a total.</p>
        {draft.costs.map((row, index) => <fieldset key={row.id} className="rounded-lg border border-slate-200 p-4 space-y-3"><legend className="px-1 text-sm font-semibold">Cost {index + 1}</legend><div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <label className="block text-sm font-medium">Description<input className={fieldClass} value={row.label} onChange={event => updateCost(row.id, 'label', event.target.value)} /></label>
          <label className="block text-sm font-medium">Cost driver<select className={fieldClass} value={row.driver} onChange={event => updateCost(row.id, 'driver', event.target.value as SaasCostDriver)}>{(['base', 'pages', 'regions', 'provider_calls', 'storage', 'worker', 'support', 'other'] as const).map(value => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label>
          <label className="block text-sm font-medium">Billing unit<input className={fieldClass} value={row.unit} onChange={event => updateCost(row.id, 'unit', event.target.value)} /></label>
          <label className="block text-sm font-medium">Unit count<input className={fieldClass} inputMode="numeric" value={row.quantity} onChange={event => updateCost(row.id, 'quantity', event.target.value)} /></label>
          <label className="block text-sm font-medium">Unit cost (USD)<input className={fieldClass} inputMode="decimal" value={row.unitCostUsd} onChange={event => updateCost(row.id, 'unitCostUsd', event.target.value)} /></label>
          <label className="block text-sm font-medium">Evidence basis<select className={fieldClass} value={row.basis} onChange={event => updateCost(row.id, 'basis', event.target.value as SaasCostBasis)}><option value="pending">Pending review</option><option value="reviewed_forecast">Reviewed forecast</option><option value="measured">Measured cost</option></select></label>
          <label className="block text-sm font-medium">Source / usage-ledger reference<input className={fieldClass} value={row.source} onChange={event => updateCost(row.id, 'source', event.target.value)} /></label>
          <label className="block text-sm font-medium">Cost or rate version<input className={fieldClass} value={row.priceVersion} onChange={event => updateCost(row.id, 'priceVersion', event.target.value)} /></label>
          <label className="block text-sm font-medium">Evidence date<input className={fieldClass} type="date" value={row.documentedDate} onChange={event => updateCost(row.id, 'documentedDate', event.target.value)} /></label>
        </div><button type="button" onClick={() => removeCost(row.id)} className="rounded border border-slate-300 px-3 py-2 text-sm" aria-label={`Remove cost ${index + 1}`}>Remove cost</button></fieldset>)}
        <button type="button" onClick={addCost} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold">Add cost</button>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={draft.coverageConfirmed} onChange={event => updateDraft('coverageConfirmed', event.target.checked)} /><span>I have covered every applicable technical cost, including operations with unknown telemetry and failed attempts. None was silently counted as zero.</span></label>
      </div>
      <fieldset className="space-y-3"><legend className="font-semibold">Applicable payment fees</legend><div className="grid sm:grid-cols-3 gap-3">{input('Fixed fee (USD)', 'fixedPaymentUsd', true)}{input('Variable fee (%)', 'paymentPercent', true)}{input('Payment method / fee source', 'paymentSource')}</div><p className="text-xs text-slate-600">No Stripe fee is assumed. Use the documented payment method and region.</p></fieldset>
      <section aria-label="Service pricing calculation result" className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-3"><h3 className="font-semibold">{result.status === 'ready_for_review' ? 'Proposal ready for review' : 'Inputs pending'}</h3><dl className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">{[['Technical cost', dollars(result.technicalCostCents)], ['Proposed service fee', dollars(result.proposedChargeCents)], ['Expected payment fees', microDollars(result.expectedPaymentFeesMicrosUsd)], ['Expected gross profit', microDollars(result.expectedGrossProfitMicrosUsd)]].map(([label, value]) => <div key={label}><dt className="text-xs text-slate-600">{label}</dt><dd className="mt-1 font-semibold text-lg">{value}</dd></div>)}</dl>
        {result.containsForecast && <p className="text-sm text-amber-900">Contains forecast costs. This is not a measured provider invoice or a verified account balance.</p>}
        {result.issues.length > 0 && <ul className="list-disc pl-5 text-sm text-amber-950 space-y-1">{Array.from(new Set(result.issues.map(issue => issue.message))).map(message => <li key={message}>{message}</li>)}</ul>}
        <button type="button" aria-expanded={auditVisible} aria-controls={`${prefix}-audit`} onClick={() => setAuditVisible(value => !value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">{auditVisible ? 'Hide calculation record' : 'Show calculation record'}</button>
        {auditVisible && <div id={`${prefix}-audit`} className="space-y-2"><p className="text-xs text-slate-600">The record contains these local inputs, cost sources, exact integer calculation and pending items. It does not modify published pricing or authorize spending. Copy it for review.</p><textarea readOnly aria-label="Auditable service pricing record" rows={12} value={exportSaasPricingPreview(draft, result)} className={`${fieldClass} font-mono text-xs`} /></div>}
      </section>
    </div>}
  </section>;
}
