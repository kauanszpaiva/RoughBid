import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ApiError, createReadingOrder, getReadingOrder, getFullTakeoffRun, payForReadingOrder, type ReadingOrder, type FullTakeoffRun } from '../services/api';
import type { PlanRevision } from '../types';
import { planFileCoverage, planFileStatus } from '../utils/planFileCoverage';
import { presentFullTakeoffStatus } from '../utils/aiPlanStatus';

const message = (error: unknown) => { if (error instanceof ApiError) { try { return JSON.parse(error.message).error ?? error.message; } catch { return error.message; } } return error instanceof Error ? error.message : 'The purchase could not be loaded.'; };
const labels = { quoted: 'Review your price', starting: 'Payment confirmed. Preparing your reading…', processing: 'Reading your files', waiting: 'Waiting for processing capacity', ready_for_review: 'Your results are ready to review', needs_attention: 'Results have pending items', revoked: 'This purchase is closed' };

export type ReadingOrderHandle = { prepare: () => Promise<void> };
export const ReadingOrderPanel = forwardRef<ReadingOrderHandle, {
  workspaceId: string; projectId: string; fileIds: string[]; revisions: PlanRevision[]; returnOrderId?: string | null;
  returned?: 'returned' | 'canceled' | undefined; available: boolean; billingAvailable: boolean; canWrite: boolean; externallyBusy: boolean;
  recoverLatest: boolean;
  actionLock: React.MutableRefObject<boolean>; onBusy: (busy: boolean) => void; beforeCheckout: (fileIds: string[]) => Promise<void>;
  onConsentRequired: () => void; onRestoreSelection: (fileIds: string[]) => void; onOpen: (fileId: string, run: FullTakeoffRun) => void;
  onOrderLoaded: (order: ReadingOrder | null) => void;
}>((props, ref) => {
  const [order, setOrder] = useState<ReadingOrder | null>(null), [runs, setRuns] = useState<Record<string, FullTakeoffRun>>({});
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [consent, setConsent] = useState(''), [refresh, setRefresh] = useState(0);
  const savedRef = useRef<ReadingOrder | null>(null), activeRef = useRef(true), requestRef = useRef(0);
  const redirecting = useRef(false);
  const propsRef = useRef(props); propsRef.current = props;
  const context = `${props.workspaceId}:${props.projectId}:${[...props.fileIds].sort().join(',')}`;
  const contextRef = useRef(context); contextRef.current = context;
  useEffect(() => { activeRef.current = true; return () => { activeRef.current = false; requestRef.current++; }; }, []);
  useEffect(() => {
    const returnedToPage = () => {
      if (!redirecting.current) return;
      redirecting.current = false; propsRef.current.actionLock.current = false;
      setBusy(false); propsRef.current.onBusy(false); setRefresh(value => value + 1);
    };
    window.addEventListener('pageshow', returnedToPage);
    return () => window.removeEventListener('pageshow', returnedToPage);
  }, []);
  const valid = (value: ReadingOrder | null) => {
    if (value && (!value.id || !value.contract_hash || !Array.isArray(value.items) || !value.items.length || value.items.length > 20
      || new Set(value.items.map(item => item.file_id)).size !== value.items.length || !Number.isSafeInteger(value.amount_cents) || value.amount_cents < 0
      || value.items.reduce((total, item) => total + item.amount_cents, 0) !== value.amount_cents
      || value.items.some(item => !props.revisions.some(revision => revision.remoteFileId === item.file_id)
        || item.full_summary.executionPolicy !== 'one-durable-run-budget-wait-no-uncertain-replay'))) throw new Error('This purchase does not match the saved PDF files. Refresh before continuing.');
    return value;
  };
  const remember = (value: ReadingOrder | null) => { savedRef.current = value; setOrder(value); setLoaded(true); propsRef.current.onOrderLoaded(value); };
  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout> | undefined;
    if (busy || props.externallyBusy) return;
    if (!props.fileIds.length && !props.returnOrderId) { remember(null); return; }
    const load = async () => {
      const request = ++requestRef.current;
      try {
        const orderId = savedRef.current?.id ?? props.returnOrderId ?? undefined;
        let value = valid(await getReadingOrder(props.workspaceId, props.projectId, { orderId, fileIds: props.fileIds }));
        if (!active || request !== requestRef.current) return;
        if (!value && !orderId && props.recoverLatest && props.fileIds[0]) value = valid(await getReadingOrder(props.workspaceId, props.projectId, { containsFileId: props.fileIds[0] }));
        if (orderId && !value) throw new Error('The saved purchase could not be found. No replacement was created.');
        if (!active || request !== requestRef.current) return;
        remember(value); setReadError(null);
        if (value && (props.returnOrderId || props.recoverLatest) && value.items.map(item => item.file_id).sort().join(',') !== [...props.fileIds].sort().join(',')) props.onRestoreSelection(value.items.map(item => item.file_id));
        const next: Record<string, FullTakeoffRun> = {};
        if (value?.status !== 'revoked') for (const item of value?.items ?? []) {
          if (!active || request !== requestRef.current) return;
          if (item.full_run_id && item.status !== 'revoked') next[item.file_id] = await getFullTakeoffRun(props.workspaceId, item.full_run_id);
        }
        if (!active || request !== requestRef.current) return;
        setRuns(next);
        if (value && (['starting', 'processing', 'waiting'].includes(value.status) || (value.status === 'quoted' && props.returned === 'returned'))) timer = setTimeout(load, 4000);
      } catch (reason) { if (active && request === requestRef.current) { setReadError(message(reason)); setLoaded(false); if (!(reason instanceof ApiError && [401, 403, 404].includes(reason.status))) timer = setTimeout(load, 8000); } }
    };
    void load(); return () => { active = false; if (timer) clearTimeout(timer); };
  }, [context, props.returnOrderId, refresh, busy, props.externallyBusy]);
  const act = async (kind: 'quote' | 'checkout') => {
    if (!props.canWrite || !props.available || !loaded || busy || props.externallyBusy || props.actionLock.current) return;
    const confirmed = order ? `${order.id}:${order.contract_hash}` : '';
    if (kind === 'checkout' && (!order || consent !== confirmed || !props.billingAvailable)) return;
    props.actionLock.current = true; setBusy(true); props.onBusy(true); setError(null); requestRef.current++;
    const actionContext = context, current = () => activeRef.current && contextRef.current === actionContext;
    let leavingForCheckout = false;
    try {
      let value = valid(await getReadingOrder(props.workspaceId, props.projectId, { orderId: savedRef.current?.id ?? props.returnOrderId ?? undefined, fileIds: props.fileIds }));
      if ((savedRef.current || props.returnOrderId) && !value) throw new Error('The saved purchase could not be found. Refresh its status before continuing.');
      if (!current()) return; remember(value);
      if (kind === 'quote') {
        if (!value || value.status === 'quoted' || (value.status === 'revoked' && value.items.every(item => !item.full_run_id))) {
          const previous = value?.status === 'revoked' ? value.id : null;
          value = valid(await createReadingOrder(props.workspaceId, props.projectId, props.fileIds));
          if (previous && value?.id === previous) throw new Error('A new purchase is required. The old purchase remains closed.');
          if (current()) { remember(value); setConsent(''); }
        }
      } else if (value?.status === 'quoted') {
        if (`${value.id}:${value.contract_hash}` !== confirmed || value.items.map(item => item.file_id).sort().join(',') !== [...props.fileIds].sort().join(',')) {
          setConsent(''); throw new Error('The files or price changed. Review the purchase and confirm again.');
        }
        await props.beforeCheckout(value.items.map(item => item.file_id));
        if (!current()) return;
        const checkout = await payForReadingOrder(props.workspaceId, props.projectId, value);
        if (current()) { window.location.assign(checkout.url); leavingForCheckout = true; redirecting.current = true; }
      }
    } catch (reason) { if (current()) { setError(message(reason)); if (reason instanceof ApiError && reason.status === 403 && /consent/i.test(message(reason))) props.onConsentRequired(); } }
    finally { if (!leavingForCheckout) { props.actionLock.current = false; propsRef.current.onBusy(false); if (current()) { setBusy(false); setRefresh(value => value + 1); } } }
  };
  const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: order?.currency ?? 'usd' }).format(cents / 100);
  useImperativeHandle(ref, () => ({ prepare: async () => {
    if (!loaded) throw new Error('Your saved purchase is still loading. Try again when its status is ready.');
    await act('quote');
    document.getElementById('selected-files-purchase')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } }));
  const disabled = !props.canWrite || busy || props.externallyBusy || !loaded;
  const expired = order?.status === 'quoted' && Date.parse(order.expires_at) <= Date.now();
  const contractKey = order ? `${order.id}:${order.contract_hash}` : '';
  return <section id="selected-files-purchase" aria-label="Selected files purchase" className="rounded-xl border border-blue-200 bg-white p-4 space-y-3">
    <div className="flex flex-wrap justify-between gap-2"><h3 className="font-bold">Read selected PDFs</h3>{order && <strong className="text-xl">{money(order.amount_cents)}</strong>}</div>
    <p className="text-sm text-slate-600">{props.fileIds.length} selected PDFs · Every page · One payment. Reading starts automatically after Stripe confirms payment.</p>
    {order && <>
      <p role="status" className="font-medium">{labels[order.status]}</p>
      {props.returned === 'canceled' && order.status === 'quoted' && <p className="text-sm">Checkout was canceled. Your selection is saved; no reading has started.</p>}
      {props.returned === 'returned' && order.status === 'quoted' && <p className="text-sm">Waiting for Stripe payment confirmation…</p>}
      <ul className="space-y-3">{order.items.map(item => {
        const run = runs[item.file_id], coverage = run ? planFileCoverage(run, item.page_count) : null;
        const presentation = run ? presentFullTakeoffStatus(run) : null;
        return <li key={item.file_id} className="rounded-lg border border-slate-200 p-3 text-sm space-y-1">
          <div className="flex flex-wrap justify-between gap-2"><strong className="break-words">{props.revisions.find(revision => revision.remoteFileId === item.file_id)?.fileName}</strong><span>{item.page_count} pages · {money(item.amount_cents)}</span></div>
          <p>{planFileStatus(run?.status ?? item.status)}</p>
          {coverage && <p className="text-slate-600">{coverage.saved}. {coverage.pending}.</p>}
          {run?.status === 'waiting_budget' && <p>{presentation?.notice}{presentation?.resumeEstimate ? ` Estimated next window: ${presentation.resumeEstimate}; this time may change.` : ''}</p>}
          {run && order.status !== 'revoked' && <button type="button" onClick={() => props.onOpen(item.file_id, run)} disabled={busy} className="underline">View results and pending items</button>}
        </li>;
      })}</ul>
      <p className="text-sm text-slate-600">This fixed price covers the selected PDFs and all their pages. Processing may wait 24 hours or longer for capacity, then continue automatically with saved progress and no extra charge. Completion time is not guaranteed. Missing information remains pending; it is never counted as zero or added twice.</p>
      {order.status === 'quoted' && <>
        <details className="text-xs text-slate-600"><summary>Scope, pricing and data use</summary><p>Price includes a conservative processing allowance and service margin. Actual AI costs may be lower. AI providers receiving the selected PDFs: {[...new Set(order.items.flatMap(item => item.full_summary.providers.map(provider => provider.provider)))].join(', ')}. Quantities, measurements and prices require review. Photos are separate and are not included in this PDF purchase.</p></details>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent === contractKey} disabled={disabled || expired} onChange={event => setConsent(event.target.checked ? contractKey : '')} /><span>I approve this {money(order.amount_cents)} purchase, sending the selected PDFs to the listed AI providers, and starting automatically after payment. I accept the scope and possible processing waits above.</span></label>
        {expired && <p className="text-sm">This price has expired. Refresh it before paying.</p>}
      </>}
    </>}
    <div className="flex flex-wrap gap-2">
      {(!order || order.status === 'quoted' || (order.status === 'revoked' && order.items.every(item => !item.full_run_id))) && <button type="button" disabled={disabled || !props.available || !props.fileIds.length || props.fileIds.length > 20} onClick={() => void act('quote')} className="rounded-lg border px-4 py-2 disabled:opacity-50">{busy ? 'Checking purchase…' : order ? 'Refresh selected files price' : 'See price for selected PDFs'}</button>}
      {order?.status === 'quoted' && <button type="button" disabled={disabled || !props.available || !props.billingAvailable || expired || consent !== contractKey} onClick={() => void act('checkout')} className="rounded-lg bg-blue-600 px-4 py-2 text-white disabled:opacity-50">Pay securely with Stripe</button>}
      <button type="button" disabled={busy} onClick={() => { setError(null); setReadError(null); setRefresh(value => value + 1); }} className="rounded-lg border px-4 py-2 disabled:opacity-50">Refresh purchase status</button>
    </div>
    {!loaded && !error && !readError && <p role="status">Checking saved purchase…</p>}
    {!props.available && <p className="text-sm text-amber-800">New readings are temporarily unavailable. Saved results remain accessible.</p>}
    {(error || readError) && <p role="alert" className="text-sm text-amber-800">{error || readError}</p>}
  </section>;
});
