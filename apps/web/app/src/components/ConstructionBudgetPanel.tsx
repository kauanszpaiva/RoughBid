import React, { useEffect, useId, useRef, useState } from 'react';
import { SupplierQuoteImportPanel } from './SupplierQuoteImportPanel';
import { reviewIssueMessage, reviewIssueMessages } from '../utils/reviewMessages';
import {
  assemblyScopeFields, compatibleBudgetAssemblies, constructionBudgetApi, constructionBudgetLimitNotices, constructionBudgetMoneySummary, budgetSourceLabel,
  constructionBudgetSelectionFromDraft, constructionCatalogInputTemplate, INITIAL_CONSTRUCTION_CATALOG, parseBudgetLocation, parseBudgetScopeQuantity, parseConstructionCatalogOverrides,
  type AcceptedBudgetMeasurement, type BudgetSelectionDraft, type BudgetSourceKind,
  type ConstructionBudgetSnapshot, type ConstructionBudgetState,
} from '../services/construction-budget-api';
import { evaluateSupplierQuote, type DocumentedSupplierQuote, type QuotedSupplier, type QuoteChannel, type SupplierQuoteRequest } from '../services/supplierQuotes';

export type ConstructionBudgetPanelProps = {
  workspaceId: string; projectId: string; canWrite: boolean;
  onEvidence?: (measurement: AcceptedBudgetMeasurement) => void;
  api?: typeof constructionBudgetApi;
  now?: () => string;
};
const formatMoney = (value: number | null) => value === null ? 'Pending' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
const inputClass = 'mt-1 block w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 focus-visible:outline-2 focus-visible:outline-blue-600';
const emptySelection = (assemblyId: string): BudgetSelectionDraft => ({ assemblyId, inputs: {}, activation: {}, equipmentAllocations: {} });
const sourceKey = (measurement: Pick<AcceptedBudgetMeasurement, 'sourceKind' | 'runId'>) => `${measurement.sourceKind}:${measurement.runId}`;

function SavedBudget({ snapshot, onLoadDetails, loading }: { snapshot: ConstructionBudgetSnapshot; onLoadDetails: () => void; loading: boolean }) {
  const summary = constructionBudgetMoneySummary(snapshot.result);
  const [showTrace, setShowTrace] = useState(false);
  return <article className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-3">
    <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">Saved construction-budget review</h3><span className="text-xs text-slate-600">{new Date(snapshot.createdAt).toLocaleString()}</span></div>
    <p className="text-sm text-slate-600">{budgetSourceLabel(snapshot.sourceKind)} source · {snapshot.selectionCount} selected quantities · Partial scope · Human review required</p>
    <dl className="grid sm:grid-cols-2 gap-3"><div><dt className="text-xs text-slate-600">Known priced subtotal</dt><dd className="font-semibold text-lg">{formatMoney(summary.knownSubtotal)}</dd></div><div><dt className="text-xs text-slate-600">Complete construction price</dt><dd className="font-semibold text-lg">{formatMoney(summary.total)}</dd></div></dl>
    <p className="text-sm text-slate-600">This saved calculation covers the selected evidence and documented inputs. It does not certify the complete building scope or include the RoughBid service fee.</p>
    {snapshot.detailLoaded === false && <div className="space-y-2"><p className="text-sm text-amber-950">The evidence and component calculations for this historical review have not been loaded. Its summary does not prove a zero price or complete scope.</p><button type="button" onClick={onLoadDetails} disabled={loading} className="rounded border px-3 py-2 text-sm disabled:opacity-50">Open saved evidence</button></div>}
    {snapshot.result.lines.length > 0 && <div className="overflow-x-auto"><table className="min-w-full text-sm text-left"><caption className="sr-only">Saved component quantities and sourced construction costs</caption><thead><tr>{['Component', 'Quantity', 'Cost', 'Pending'].map(label => <th key={label} scope="col" className="p-2 border-b">{label}</th>)}</tr></thead><tbody>{snapshot.result.lines.map(line => <tr key={line.id} className="align-top"><th scope="row" className="p-2 font-medium">{line.description}<span className="block text-xs text-slate-500">{line.category}</span></th><td className="p-2 whitespace-nowrap">{line.quantity === null ? 'Pending quantity' : `${line.quantity.toLocaleString()} ${line.unit}`}</td><td className="p-2 whitespace-nowrap">{formatMoney(line.cost)}</td><td className="p-2 text-xs text-amber-950">{line.pending.length ? reviewIssueMessages(line.pending).join(' ') : 'Priced from documented sources'}</td></tr>)}</tbody></table></div>}
    {snapshot.result.missingInputs.length > 0 && <details><summary className="cursor-pointer text-sm font-semibold text-amber-950">{snapshot.result.missingInputs.length} unresolved inputs</summary><ul className="list-disc pl-5 text-sm mt-2 space-y-1">{snapshot.result.missingInputs.map((item, index) => <li key={`${index}-${item}`}>{reviewIssueMessage(item)}</li>)}</ul></details>}
    {snapshot.result.warnings.length > 0 && <ul className="list-disc pl-5 text-sm text-amber-950">{snapshot.result.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{reviewIssueMessage(warning)}</li>)}</ul>}
    {snapshot.result.missingInputs.length > 0 && <details className="text-xs text-slate-500"><summary className="cursor-pointer">Advanced diagnostic codes</summary><ul>{snapshot.result.missingInputs.map((code, index) => <li key={index}>{code}</li>)}</ul></details>}
    <button type="button" aria-expanded={showTrace} disabled={snapshot.detailLoaded === false} onClick={() => setShowTrace(value => !value)} className="rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-50">{showTrace ? 'Hide source and calculation details' : 'View source and calculation details'}</button>
    {showTrace && <details className="rounded border p-3"><summary className="cursor-pointer text-sm">Advanced calculation record</summary><textarea readOnly rows={10} aria-label="Saved construction-budget calculation and evidence" className={`${inputClass} font-mono text-xs`} value={JSON.stringify(snapshot, null, 2)} /></details>}
  </article>;
}

/** Accepted quantities come from the scoped API. This view neither measures geometry nor contacts suppliers or AI providers. */
export function ConstructionBudgetPanel({ workspaceId, projectId, canWrite, onEvidence, api = constructionBudgetApi, now = () => new Date().toISOString() }: ConstructionBudgetPanelProps) {
  const prefix = useId();
  const scopeId = `${workspaceId}:${projectId}`;
  const currentScope = useRef(scopeId); currentScope.current = scopeId;
  const [state, setState] = useState<ConstructionBudgetState | null>(null);
  const [loadedScope, setLoadedScope] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveUncertain, setSaveUncertain] = useState(false);
  const [runKey, setRunKey] = useState('');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Record<string, BudgetSelectionDraft>>({});
  const [bindings, setBindings] = useState<Record<string, { quoteId: string; specificationReviewed: boolean }>>({});
  const [postalCode, setPostalCode] = useState('');
  const [storeId, setStoreId] = useState('');
  const [timeZone, setTimeZone] = useState('');
  const [supplier, setSupplier] = useState<QuotedSupplier>('other');
  const [channel, setChannel] = useState<QuoteChannel>('pickup');
  const [sku, setSku] = useState('');
  const [variant, setVariant] = useState('');
  const [catalogDocument, setCatalogDocument] = useState('');
  const [savedSnapshotId, setSavedSnapshotId] = useState('');
  const visibleState = loadedScope === scopeId ? state : null;

  const refresh = async () => {
    const captured = scopeId;
    setLoading(true); setError(null);
    try {
      const data = await api.get(workspaceId, projectId);
      if (currentScope.current !== captured) return;
      setState(data); setLoadedScope(captured); setSaveUncertain(false);
      if (data.location) { setPostalCode(data.location.postalCode); setStoreId(data.location.storeId); setTimeZone(data.location.timeZone); }
    } catch (cause) { if (currentScope.current === captured) setError(cause instanceof Error ? cause.message : 'Saved budgets could not be loaded.'); }
    finally { if (currentScope.current === captured) setLoading(false); }
  };
  useEffect(() => {
    let active = true;
    setState(null); setLoadedScope(''); setRunKey(''); setSelected({}); setBindings({});
    setPostalCode(''); setStoreId(''); setTimeZone(''); setCatalogDocument(''); setSavedSnapshotId(''); setSaveUncertain(false); setBusy(false); setLoading(true); setError(null);
    api.get(workspaceId, projectId).then(data => {
      if (!active || currentScope.current !== scopeId) return;
      setState(data); setLoadedScope(scopeId);
      if (data.location) { setPostalCode(data.location.postalCode); setStoreId(data.location.storeId); setTimeZone(data.location.timeZone); }
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Construction budget could not be loaded.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workspaceId, projectId, api]);

  const location = parseBudgetLocation(postalCode, storeId, timeZone);
  const quoteRequest: SupplierQuoteRequest = { supplier, location, sku: sku.trim() || null, variant: variant.trim() || null, channel, quantity: null, pricedUnit: null, mode: 'documented_quote', partnerAccessVerified: false, contractEligibilityVerified: false };
  const runs = Array.from(new Map((visibleState?.measurements ?? []).map(measurement => [sourceKey(measurement), { sourceKind: measurement.sourceKind, runId: measurement.runId }])).entries());
  const effectiveRunKey = runs.some(([key]) => key === runKey) ? runKey : runs[0]?.[0] ?? '';
  const measurements = (visibleState?.measurements ?? []).filter(measurement => sourceKey(measurement) === effectiveRunKey);
  const allCategories = Array.from(new Set(INITIAL_CONSTRUCTION_CATALOG.assemblies.map(assembly => assembly.category))).sort();
  const shownCatalog = INITIAL_CONSTRUCTION_CATALOG.assemblies.filter(assembly => (!category || assembly.category === category) && (!search.trim() || `${assembly.name} ${assembly.description} ${assembly.category}`.toLowerCase().includes(search.toLowerCase().trim())));
  const selectedMaterialIds = new Set(measurements.flatMap(measurement => INITIAL_CONSTRUCTION_CATALOG.assemblies.find(assembly => assembly.id === selected[measurement.id]?.assemblyId)?.materials.map(material => material.id) ?? []));
  const latest = visibleState?.snapshots.find(snapshot => snapshot.id === savedSnapshotId) ?? visibleState?.snapshots[0];
  const chosenCount = measurements.filter(measurement => selected[measurement.id]?.assemblyId).length;

  const chooseAssembly = (measurementId: string, assemblyId: string) => setSelected(current => ({ ...current, [measurementId]: emptySelection(assemblyId) }));
  const editScope = (measurementId: string, componentId: string, key: string, patch: Partial<{ value: string; confirmed: boolean; sourceRef: string }>) => setSelected(current => {
    const draft = current[measurementId]; if (!draft) return current;
    const old = draft.inputs[componentId]?.[key] ?? { value: '', confirmed: false, sourceRef: '' };
    return { ...current, [measurementId]: { ...draft, inputs: { ...draft.inputs, [componentId]: { ...draft.inputs[componentId], [key]: { ...old, ...patch } } } } };
  });
  const setActivation = (measurementId: string, componentId: string, value: string) => setSelected(current => {
    const draft = current[measurementId]; return !draft ? current : { ...current, [measurementId]: { ...draft, activation: { ...draft.activation, [componentId]: value === 'include' ? true : value === 'exclude' ? false : null } } };
  });
  const editEquipment = (measurementId: string, equipmentId: string, patch: Partial<{ value: string; confirmed: boolean; sourceRef: string }>) => setSelected(current => {
    const draft = current[measurementId]; if (!draft) return current;
    const old = draft.equipmentAllocations?.[equipmentId] ?? { value: '', confirmed: false, sourceRef: '' };
    return { ...current, [measurementId]: { ...draft, equipmentAllocations: { ...draft.equipmentAllocations, [equipmentId]: { ...old, ...patch } } } };
  });

  const save = async () => {
    if (!visibleState || busy || !canWrite || saveUncertain) return;
    const captured = scopeId;
    setBusy(true); setError(null);
    let dispatched = false;
    try {
      const source = runs.find(([key]) => key === effectiveRunKey)?.[1];
      if (!source) throw new Error('There are no accepted quantities from a saved source run. Review a plan or photo first.');
      const selections = measurements.flatMap(measurement => {
        const draft = selected[measurement.id]; if (!draft?.assemblyId) return [];
        const assembly = INITIAL_CONSTRUCTION_CATALOG.assemblies.find(item => item.id === draft.assemblyId);
        if (!assembly) throw new Error('The selected catalog assembly is unavailable.');
        return [constructionBudgetSelectionFromDraft(measurement, assembly, draft)];
      });
      if (!selections.length) throw new Error('Choose a service for at least one accepted quantity.');
      const quoteBindings = Object.entries(bindings).flatMap(([componentId, binding]) => {
        if (!selectedMaterialIds.has(componentId) || !binding.quoteId || !binding.specificationReviewed) return [];
        const quote = visibleState.quotes.find(item => item.id === binding.quoteId);
        if (!quote) throw new Error('A selected product quote is no longer available. Refresh the saved quotes.');
        return [{ componentId, quoteId: quote.id, supplier: quote.supplier, sku: quote.sku, variant: quote.variant, channel: quote.channel, specificationReviewed: true as const }];
      });
      const catalogOverrides = parseConstructionCatalogOverrides(catalogDocument);
      dispatched = true;
      const saved = await api.save(workspaceId, projectId, { ...source, selections, quoteIds: Array.from(new Set(quoteBindings.map(binding => binding.quoteId))), quoteBindings, ...(catalogOverrides ? { catalogOverrides } : {}), ...(location ? { location } : {}) });
      if (currentScope.current !== captured) return;
      setSavedSnapshotId(saved.snapshot.id);
      setState(current => current ? { ...current, snapshots: [saved.snapshot, ...current.snapshots.filter(snapshot => snapshot.id !== saved.snapshot.id)] } : current);
    } catch (cause) {
      if (currentScope.current === captured) { setSaveUncertain(dispatched); setError(`${cause instanceof Error ? cause.message : 'Budget could not be saved.'}${dispatched ? ' Refresh saved budgets before trying again; a response failure does not prove the save failed.' : ''}`); }
    } finally { if (currentScope.current === captured) setBusy(false); }
  };
  const importQuotes = async (quotes: readonly DocumentedSupplierQuote[]) => {
    if (!canWrite || busy) throw new Error('Write permission is required to import project quotes.');
    const captured = scopeId; setBusy(true);
    try {
      const saved = await api.importQuotes(workspaceId, projectId, quotes);
      if (currentScope.current === captured) setState(current => current ? { ...current, quotes: [...saved.quotes, ...current.quotes.filter(quote => !saved.quotes.some(item => item.id === quote.id))] } : current);
    } finally { if (currentScope.current === captured) setBusy(false); }
  };
  const openSavedDetails = async (snapshotId: string) => {
    if (loading || busy) return;
    const captured = scopeId; setLoading(true); setError(null);
    try {
      const data = await api.get(workspaceId, projectId, snapshotId);
      if (currentScope.current !== captured) return;
      const selectedSnapshot = data.snapshots.find(snapshot => snapshot.id === snapshotId);
      if (!selectedSnapshot || selectedSnapshot.detailLoaded === false) throw new Error('The selected saved evidence was not returned. Its full calculation remains unloaded.');
      setState(data); setLoadedScope(captured); setSavedSnapshotId(snapshotId);
    } catch (cause) { if (currentScope.current === captured) setError(cause instanceof Error ? cause.message : 'Saved evidence could not be loaded.'); }
    finally { if (currentScope.current === captured) setLoading(false); }
  };

  return <section aria-label="Construction catalog and evidenced budget" className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6 space-y-5">
    <header className="flex flex-wrap justify-between gap-3"><div><h2 className="text-xl font-semibold text-slate-950">Construction catalog &amp; budget</h2><p className="mt-1 text-sm text-slate-600">Link accepted quantities to documented materials, labor and equipment.</p></div><button type="button" onClick={() => void refresh()} disabled={loading || busy} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50">{loading ? 'Loading.' : 'Refresh saved budgets'}</button></header>
    {!canWrite && <p className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950">Read-only access. Accepted evidence, saved quotes and budget reviews remain visible.</p>}
    {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">{error}</p>}
    {loading && !visibleState && <p role="status" className="text-sm text-slate-600">Loading saved project quantities and budget reviews.</p>}
    {visibleState && <>
      <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">Scope coverage is partial. Unreviewed or estimated quantities are excluded from costing. Missing prices, packaging, waste, labor productivity and equipment/access decisions remain pending.</p>
      {constructionBudgetLimitNotices(visibleState).length > 0 && <section aria-label="Budget view coverage limits" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"><ul className="list-disc pl-5 space-y-1">{constructionBudgetLimitNotices(visibleState).map(notice => <li key={notice}>{notice}</li>)}</ul></section>}
      <details className="rounded-lg border border-slate-200 p-4"><summary className="cursor-pointer font-semibold">Explore the initial catalog ({INITIAL_CONSTRUCTION_CATALOG.assemblies.length} services)</summary><p className="text-sm text-slate-600 mt-3">An extensible scope catalog, not a universally complete or priced list. Product specifications and quantities still need project evidence.</p><div className="grid sm:grid-cols-2 gap-3 mt-3"><label className="text-sm font-medium">Category<select value={category} onChange={event => setCategory(event.target.value)} className={inputClass}><option value="">All categories</option>{allCategories.map(value => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label><label className="text-sm font-medium">Find a service<input value={search} onChange={event => setSearch(event.target.value)} className={inputClass} /></label></div><ul className="mt-3 space-y-2 max-h-80 overflow-y-auto">{shownCatalog.map(assembly => <li key={assembly.id} className="border-t pt-2 text-sm"><strong>{assembly.name}</strong><span className="text-slate-500"> · {assembly.unit} · {assembly.category.replaceAll('_', ' ')}</span><p className="text-slate-600">{assembly.description}</p><p className="text-xs text-amber-950">Prices, productivity, waste and purchasing coverage require documented inputs.</p></li>)}</ul><p className="mt-2 text-xs text-slate-500">{shownCatalog.length} services match this filter.</p></details>
      <section aria-label="Accepted source quantities" className="space-y-3"><h3 className="font-semibold">Accepted quantities</h3><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-slate-600">After reviewing and accepting source measurements, refresh to load their saved acceptance state.</p><button type="button" onClick={() => void refresh()} disabled={loading || busy} className="rounded border px-3 py-2 text-sm disabled:opacity-50">Refresh accepted quantities</button></div>{runs.length > 0 && <label className="block text-sm font-medium">Evidence source<select className={inputClass} value={effectiveRunKey} onChange={event => { setRunKey(event.target.value); setSelected({}); setBindings({}); }} disabled={busy}>{runs.map(([key, source]) => <option key={key} value={key}>{budgetSourceLabel(source.sourceKind)} run {source.runId.slice(0, 8)} · {visibleState.measurements.filter(measure => sourceKey(measure) === key).length} accepted quantities</option>)}</select></label>}
        {measurements.length === 0 ? <p className="text-sm text-amber-950">No accepted quantities are available. Review and accept evidenced measurements in the plan or photo workflow before costing. Estimated observations do not become verified measurements here.</p> : <fieldset className="space-y-3"><legend className="sr-only">Select services for accepted measurements</legend>{measurements.map(measurement => {
          const draft = selected[measurement.id]; const assembly = INITIAL_CONSTRUCTION_CATALOG.assemblies.find(item => item.id === draft?.assemblyId);
          const options = compatibleBudgetAssemblies(measurement); const scopeFields = assembly ? assemblyScopeFields(assembly) : [];
          return <article key={measurement.id} className="rounded-lg border border-slate-200 p-4 space-y-3"><div className="flex flex-wrap justify-between gap-2"><div><h4 className="font-medium">{measurement.label}</h4><p className="text-sm">{measurement.quantity.toLocaleString()} {measurement.unit} · Accepted{measurement.pageNumber ? ` · sheet ${measurement.pageNumber}` : ''}</p><p className="text-xs text-slate-500 break-all">Evidence: {measurement.evidenceRef}</p></div>{onEvidence && <button type="button" className="rounded border px-3 py-2 text-sm" onClick={() => onEvidence(measurement)}>Open source evidence</button>}</div><label className="block text-sm font-medium">Service with matching units<select className={inputClass} value={draft?.assemblyId ?? ''} disabled={!canWrite || busy || saveUncertain} onChange={event => chooseAssembly(measurement.id, event.target.value)}><option value="">Choose a service</option>{options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>{options.length === 0 && <p className="text-sm text-amber-950">No initial service matches this unit. An explicit reviewed composition is required; no browser unit conversion is assumed.</p>}
            {assembly && <details><summary className="cursor-pointer text-sm font-semibold">Component scope and documented inputs</summary><p className="text-xs text-slate-600 mt-2">Select applicable components. Every extra dimension or coefficient needs its own source; the accepted measurement is read-only.</p><fieldset disabled={!canWrite || busy || saveUncertain} className="mt-3 space-y-3">{assembly.materials.map(material => <div key={material.id} className="rounded border border-slate-200 p-3 space-y-2"><p className="text-sm font-medium">{material.name}</p><label className="block text-sm">Component scope<select className={inputClass} value={draft?.activation[material.id] === true ? 'include' : draft?.activation[material.id] === false ? 'exclude' : 'pending'} onChange={event => setActivation(measurement.id, material.id, event.target.value)}><option value="pending">Scope pending</option><option value="include">Required for this service</option><option value="exclude">Confirmed outside this scope</option></select></label>{scopeFields.filter(field => field.componentId === material.id).map(field => { const value = draft?.inputs[material.id]?.[field.key] ?? { value: '', confirmed: false, sourceRef: '' }; return <fieldset key={field.key} className="grid sm:grid-cols-2 gap-2 border-t pt-2"><legend className="text-xs font-semibold">{field.key.replaceAll('_', ' ')} ({field.unit})</legend><label className="block text-xs">Documented value<input className={inputClass} inputMode="decimal" value={value.value} onChange={event => editScope(measurement.id, material.id, field.key, { value: event.target.value, confirmed: false })} /></label><label className="block text-xs">Source / dimension reference<input className={inputClass} value={value.sourceRef} onChange={event => editScope(measurement.id, material.id, field.key, { sourceRef: event.target.value, confirmed: false })} /></label><label className="flex items-start gap-2 text-xs sm:col-span-2"><input type="checkbox" checked={value.confirmed} onChange={event => editScope(measurement.id, material.id, field.key, { confirmed: event.target.checked })} /><span>I reviewed this specific input and its unit against the cited source.</span></label></fieldset>; })}</div>)}</fieldset><p className="text-xs text-amber-950 mt-3">Labor productivity, crew cost, equipment allocation and site constraints require their own documented catalog entries.</p></details>}
            {assembly && assembly.equipmentIds.length > 0 && <details>
              <summary className="cursor-pointer text-sm font-semibold">Documented equipment applicability and usage allocation</summary>
              <p className="mt-2 text-xs text-slate-600">These are manual job usage allocations, not dimensions measured by AI. Confirm whether each equipment item is applicable and cite its unique usage or rental allocation. Shared use must be apportioned without counting the same rental again in another service.</p>
              <fieldset disabled={!canWrite || busy || saveUncertain} className="mt-3 space-y-3">
                {assembly.equipmentIds.map(equipmentId => {
                  const allocation = draft?.equipmentAllocations?.[equipmentId] ?? { value: '', confirmed: false, sourceRef: '' };
                  const numeric = parseBudgetScopeQuantity(allocation.value);
                  const invalid = Boolean(allocation.value.trim()) && (numeric === null || numeric > 1_000_000);
                  const name = INITIAL_CONSTRUCTION_CATALOG.equipment.find(item => item.id === equipmentId)?.name ?? equipmentId;
                  return <fieldset key={equipmentId} className="rounded border border-slate-200 p-3 space-y-2">
                    <legend className="px-1 text-sm font-medium">{name}</legend>
                    <div className="grid sm:grid-cols-2 gap-3">
                      <label className="block text-xs">Usage allocation count (EA)<input value={allocation.value} inputMode="decimal" aria-invalid={invalid} className={inputClass} onChange={event => editEquipment(measurement.id, equipmentId, { value: event.target.value, confirmed: false })} /></label>
                      <label className="block text-xs">Documented usage / rental allocation reference<input value={allocation.sourceRef} maxLength={240} className={inputClass} onChange={event => editEquipment(measurement.id, equipmentId, { sourceRef: event.target.value, confirmed: false })} /></label>
                    </div>
                    {invalid && <p className="text-xs text-red-800">Enter a documented allocation from 0 to 1,000,000 EA with at most six decimal places. This input remains pending.</p>}
                    <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={allocation.confirmed} onChange={event => editEquipment(measurement.id, equipmentId, { confirmed: event.target.checked })} /><span>I reviewed this equipment's applicability, usage count and source, and checked that the allocation does not duplicate the same job usage.</span></label>
                    <p className="text-xs text-amber-950">{!allocation.value.trim() ? 'Usage quantity pending; no default count is assumed.' : !allocation.confirmed || !allocation.sourceRef.trim() || invalid ? 'Usage allocation remains unreviewed or incomplete.' : 'Reviewed allocation will be saved with its source. Rental period, operator, transport, fuel, fees and site constraints still need documented catalog inputs.'}</p>
                  </fieldset>;
                })}
              </fieldset>
            </details>}
          </article>;
        })}</fieldset>}
        {Boolean(visibleState.pendingMeasurements?.length) && <details><summary className="cursor-pointer text-sm text-amber-950">{visibleState.pendingMeasurements!.length} observations excluded until accepted</summary><ul className="mt-2 text-sm space-y-2">{visibleState.pendingMeasurements!.map(item => <li key={item.id}>{item.label}: {item.reviewStatus}{item.reason ? ` · ${item.reason}` : ''}. {item.quantity === null ? 'Physical quantity pending.' : `${item.quantity} ${item.unit ?? ''} is unaccepted.`}</li>)}</ul></details>}
      </section>
      <fieldset disabled={!canWrite || busy} className="space-y-3"><legend className="font-semibold">Supplier location and documented quotes</legend><p className="text-sm text-slate-600">Choose the actual project ZIP, store and time zone. Retail pages may select a different store automatically. No supplier API or crawler is invoked.</p><div className="grid sm:grid-cols-3 gap-3"><label className="block text-sm">Project ZIP<input value={postalCode} onChange={event => setPostalCode(event.target.value)} inputMode="numeric" className={inputClass} /></label><label className="block text-sm">Selected store ID<input value={storeId} onChange={event => setStoreId(event.target.value)} className={inputClass} /></label><label className="block text-sm">Project time zone<input value={timeZone} onChange={event => setTimeZone(event.target.value)} placeholder="IANA time zone" className={inputClass} /></label></div>{!location && <p role="status" className="text-sm text-amber-950">Location pending. No price is verified for today's project location.</p>}
        {canWrite && <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3"><label className="block text-sm">Supplier<select value={supplier} onChange={event => setSupplier(event.target.value as QuotedSupplier)} className={inputClass}><option value="other">Select / other supplier</option><option value="home_depot">The Home Depot</option><option value="lowes">Lowe's</option><option value="floor_and_decor">Floor &amp; Decor</option></select></label><label className="block text-sm">Purchase channel<select value={channel} onChange={event => setChannel(event.target.value as QuoteChannel)} className={inputClass}>{(['pickup', 'delivery', 'online', 'contract'] as const).map(value => <option key={value}>{value}</option>)}</select></label><label className="block text-sm">Exact SKU<input value={sku} onChange={event => setSku(event.target.value)} className={inputClass} /></label><label className="block text-sm">Model / variant<input value={variant} onChange={event => setVariant(event.target.value)} className={inputClass} /></label></div>}
      </fieldset>
      {canWrite && <SupplierQuoteImportPanel key={scopeId} request={quoteRequest} onImport={importQuotes} now={now} />}
      {visibleState.quotes.length > 0 && <section className="space-y-3" aria-label="Saved documented project quotes"><h3 className="font-semibold">Saved documented quotes</h3><p className="text-xs text-slate-500">Showing {visibleState.quotes.length} quotes returned by the scoped API. Original evidence dates are retained.</p><ul className="space-y-2">{visibleState.quotes.map(quote => { let stateLabel = 'Quote review pending'; let pending = ''; try { const evaluation = evaluateSupplierQuote({ ...quoteRequest, supplier: quote.supplier, sku: quote.sku, variant: quote.variant, channel: quote.channel, quantity: quote.quotedQuantity, pricedUnit: quote.pricedUnit }, quote, now()); stateLabel = evaluation.label; pending = reviewIssueMessages(evaluation.pending).join(' '); } catch { stateLabel = 'Quote evidence could not be verified'; } return <li key={quote.id} className="rounded border border-slate-200 p-3 text-sm"><p className="font-medium">{quote.supplierName} · {quote.sku}{quote.variant ? ` · ${quote.variant}` : ''}</p><p>{formatMoney(quote.unitPrice)} / {quote.pricedUnit} · {quote.location.postalCode} · store {quote.location.storeId}</p><p className="text-xs text-slate-600">Origin: {quote.origin.replaceAll('_', ' ')} · Evidence {quote.evidenceAt} · {quote.availability.replaceAll('_', ' ')}</p><p className="text-sm text-amber-950">{stateLabel}{pending ? ` · ${pending}` : ''}</p>{quote.sourceUrl && <a href={quote.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-700 underline">Open original source</a>}{quote.documentRef && <p className="text-xs">Document: {quote.documentRef}</p>}</li>; })}</ul></section>}
      {selectedMaterialIds.size > 0 && <fieldset disabled={!canWrite || busy || saveUncertain} className="space-y-3">
        <legend className="font-semibold">Bind exact product quotes to selected components</legend>
        <p className="text-xs text-slate-600">A supplier quote does not choose a product specification or coverage. Bind only the exact SKU/model and packaging confirmed for this component.</p>
        {Array.from(selectedMaterialIds).map(componentId => {
          const binding = bindings[componentId];
          const quote = visibleState.quotes.find(item => item.id === binding?.quoteId);
          const name = INITIAL_CONSTRUCTION_CATALOG.assemblies.flatMap(item => item.materials).find(item => item.id === componentId)?.name ?? componentId;
          return <div key={componentId} className="rounded border border-slate-200 p-3 space-y-2">
            <label className="block text-sm">{name}<select className={inputClass} value={binding?.quoteId ?? ''} onChange={event => setBindings(current => ({ ...current, [componentId]: { quoteId: event.target.value, specificationReviewed: false } }))}>
              <option value="">Quote pending</option>{visibleState.quotes.map(item => <option key={item.id} value={item.id}>{item.supplierName} · {item.sku} · {formatMoney(item.unitPrice)} / {item.pricedUnit}</option>)}
            </select></label>
            {quote && <>
              <p className="text-xs text-slate-600">SKU {quote.sku} · {quote.model ?? 'Model pending'} · {quote.variant ?? 'Variant not documented'} · {quote.channel} · {quote.quotedQuantity} {quote.pricedUnit} quoted</p>
              <p className="text-xs text-slate-600">Specification: {quote.specification ?? 'Pending exact specification'}. Coverage: {quote.coveragePerPricedUnit ? `${quote.coveragePerPricedUnit.quantity} ${quote.coveragePerPricedUnit.unit} / ${quote.pricedUnit}` : 'Pending package coverage'}.</p>
              <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={binding?.specificationReviewed ?? false} onChange={event => setBindings(current => ({ ...current, [componentId]: { quoteId: quote.id, specificationReviewed: event.target.checked } }))} /><span>I reviewed this exact SKU/model, specification and purchasing unit against the selected component.</span></label>
              {!binding?.specificationReviewed && <p className="text-xs text-amber-950">This product binding is pending review and will not supply a price.</p>}
            </>}
          </div>;
        })}
      </fieldset>}
      {canWrite && <details className="rounded-lg border border-slate-200 p-4"><summary className="cursor-pointer text-sm font-semibold">Advanced catalog import for labor, packaging and equipment</summary><p className="mt-2 text-xs text-slate-600">Advanced import for reviewed catalog inputs. Record source dates, packaging, crew productivity and equipment applicability. Values without supporting evidence remain pending.</p><button type="button" disabled={busy || saveUncertain || chosenCount === 0} className="mt-3 rounded border px-3 py-2 text-sm" onClick={() => { try { setCatalogDocument(JSON.stringify(constructionCatalogInputTemplate(measurements.map(measurement => selected[measurement.id]?.assemblyId).filter((id): id is string => Boolean(id))), null, 2)); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Catalog template could not be created.'); } }}>Load selected catalog template with pending inputs</button><label className="mt-3 block text-sm">Documented catalog JSON<textarea rows={7} maxLength={1_000_000} value={catalogDocument} onChange={event => setCatalogDocument(event.target.value)} disabled={busy || saveUncertain} className={`${inputClass} font-mono text-xs`} /></label></details>}
      {canWrite && <div className="space-y-2"><button type="button" onClick={() => void save()} disabled={busy || saveUncertain || chosenCount === 0} className="rounded-lg bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Saving.' : 'Calculate & save budget review'}</button><p className="text-xs text-slate-600">Calculation is deterministic and saves a review snapshot. Missing inputs remain explicit; this action does not call an AI or supplier, charge anyone, or send a client quote.</p>{saveUncertain && <p role="status" className="text-sm text-amber-950">Save status needs confirmation. Refresh saved budgets before submitting again.</p>}</div>}
      {latest && <SavedBudget key={latest.id} snapshot={latest} onLoadDetails={() => void openSavedDetails(latest.id)} loading={loading || busy} />}
      {visibleState.snapshots.length > 1 && <label className="block text-sm font-medium">Saved review history<select className={inputClass} value={latest?.id ?? ''} onChange={event => setSavedSnapshotId(event.target.value)}>{visibleState.snapshots.map(snapshot => <option key={snapshot.id} value={snapshot.id}>{new Date(snapshot.createdAt).toLocaleString()} · {snapshot.selectionCount} selected · {snapshot.result.status}</option>)}</select></label>}
    </>}
  </section>;
}
