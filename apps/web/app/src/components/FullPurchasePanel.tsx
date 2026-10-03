import React, { useEffect, useRef, useState } from 'react';
import {
  ApiError, getFullReadingQuote, getSavedFullReadingQuote, getFullTakeoffRun,
  payForFullReading, startPurchasedFullReading,
  type FullReadingQuote, type FullTakeoffRun,
} from '../services/api';
import { presentFullTakeoffStatus } from '../utils/aiPlanStatus';
import { readFullPurchaseReturn } from '../utils/fullPurchaseReturn';

type Props = {
  workspaceId: string; projectId: string; fileId: string; fileName: string; revisionName: string;
  canWrite: boolean; available: boolean; billingAvailable: boolean; complimentaryAvailable: boolean;
  externallyBusy: boolean; actionLock: React.MutableRefObject<boolean>;
  onBusyChange: (busy: boolean) => void;
  onConsentRequired: () => void;
  beforeCheckout: (fileId: string) => Promise<void>;
  onRun: (run: FullTakeoffRun, open: boolean) => void;
};
const errorText = (error: unknown) => {
  if (error instanceof ApiError) {
    try { const body = JSON.parse(error.message); if (typeof body.error === 'string') return body.error; } catch { /* Plain API error. */ }
  }
  return error instanceof Error ? error.message : 'The saved purchase could not be loaded.';
};

/** The browser never chooses a purchased run's provider budget or treats a redirect as payment. */
export function FullPurchasePanel(props: Props) {
  const { workspaceId, projectId, fileId, available, canWrite, actionLock } = props;
  const target = readFullPurchaseReturn(window.location.search);
  const returned = target?.workspaceId === workspaceId && target.projectId === projectId && target.fileId === fileId ? target : null;
  const [expanded, setExpanded] = useState(Boolean(returned) || !props.complimentaryAvailable);
  const [quote, setQuote] = useState<FullReadingQuote | null>(null);
  const [run, setRun] = useState<FullTakeoffRun | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [consentKey, setConsentKey] = useState('');
  const [refresh, setRefresh] = useState(0);
  const quoteRef = useRef<FullReadingQuote | null>(null);
  const propsRef = useRef(props); propsRef.current = props;
  const mounted = useRef(true);
  const requestId = useRef(0);
  const redirecting = useRef(false);
  const notifiedRun = useRef('');
  const observedRun = useRef<{ id: string; status: string } | null>(null);
  const openedResult = useRef('');
  const context = `${workspaceId}:${projectId}:${fileId}`;
  const contextRef = useRef(context); contextRef.current = context;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestId.current++; }; }, []);
  useEffect(() => {
    const returnedToPage = () => {
      if (!redirecting.current) return;
      redirecting.current = false; actionLock.current = false; setBusy(false);
      propsRef.current.onBusyChange(false); setRefresh(value => value + 1);
    };
    window.addEventListener('pageshow', returnedToPage);
    return () => window.removeEventListener('pageshow', returnedToPage);
  }, [actionLock]);

  const validQuote = (value: FullReadingQuote | null) => {
    if (value && (value.mode !== 'full_v2' || value.file_id !== fileId || value.project_id !== projectId
      || !value.full_contract_hash || !value.full_summary || value.full_summary.executionPolicy !== 'one-durable-run-budget-wait-no-uncertain-replay')) {
      throw new Error('The saved purchase does not match this Full reading. Refresh before continuing.');
    }
    return value;
  };
  const remember = (value: FullReadingQuote | null) => {
    quoteRef.current = value; setQuote(value); setLoaded(true);
    if (value) setExpanded(true);
  };
  const rememberRun = (value: FullTakeoffRun, open = false) => {
    setRun(value);
    const finished = ['ready', 'needs_review'].includes(value.status);
    const wasReading = observedRun.current?.id === value.id && ['queued', 'processing', 'waiting_budget'].includes(observedRun.current.status);
    if (finished && openedResult.current !== value.id && (wasReading || returned?.payment === 'returned')) { open = true; openedResult.current = value.id; }
    observedRun.current = { id: value.id, status: value.status };
    const key = `${value.id}:${value.status}`;
    if (open || notifiedRun.current !== key) {
      notifiedRun.current = key;
      propsRef.current.onRun(value, open);
    }
  };

  // GET-only recovery continues independently of current provider availability.
  // In particular, payment=returned cannot create a quote, Checkout or AI run.
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (busy || props.externallyBusy) return;
    const load = async () => {
      const id = ++requestId.current;
      try {
        const quoteId = quoteRef.current?.id ?? returned?.quoteId;
        const saved = validQuote(await getSavedFullReadingQuote(workspaceId, projectId, fileId, quoteId));
        if (quoteId && !saved) throw new Error('The saved purchase could not be found. No replacement purchase was created.');
        if (!active || id !== requestId.current) return;
        remember(saved); setReadError(null);
        if (saved?.full_run_id && saved.status !== 'revoked') {
          const value = await getFullTakeoffRun(workspaceId, saved.full_run_id);
          if (!active || id !== requestId.current) return;
          rememberRun(value);
        }
        if (saved && (['paid', 'processing'].includes(saved.status)
          || (saved.status === 'quoted' && (returned?.payment === 'returned' || saved.full_consent_confirmed)))) timer = setTimeout(load, 4000);
      } catch (error) {
        if (!active || id !== requestId.current) return;
        setReadError(errorText(error)); setLoaded(false);
      }
    };
    void load();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [context, refresh, busy, props.externallyBusy]);

  const act = async (kind: 'quote' | 'checkout' | 'start' | 'open') => {
    if (!canWrite || busy || props.externallyBusy || actionLock.current || !loaded) return;
    const confirmedKey = quote ? `${quote.id}:${quote.full_contract_hash}` : '';
    if (kind === 'checkout' && (!quote || consentKey !== confirmedKey || !props.billingAvailable)) return;
    if (kind === 'quote' && !available) return;
    actionLock.current = true; setBusy(true); props.onBusyChange(true); setNotice(null);
    const actionContext = context;
    requestId.current++;
    const current = () => mounted.current && contextRef.current === actionContext;
    let leavingForCheckout = false;
    try {
      // Reconcile first: a late webhook must win over a reprice or repeated click.
      let saved = validQuote(await getSavedFullReadingQuote(workspaceId, projectId, fileId, quoteRef.current?.id ?? returned?.quoteId));
      if ((quoteRef.current?.id || returned?.quoteId) && !saved) throw new Error('The saved purchase could not be found. Refresh its status before continuing.');
      if (!current()) return;
      remember(saved);
      if (kind === 'quote') {
        if (!saved || saved.status === 'quoted' || (saved.status === 'revoked' && !saved.full_run_id)) {
          const revokedId = saved?.status === 'revoked' ? saved.id : null;
          saved = validQuote(await getFullReadingQuote(workspaceId, projectId, fileId));
          if (revokedId && saved?.id === revokedId) throw new Error('The previous purchase is closed. A new quote is required before checkout.');
          if (current()) { remember(saved); setConsentKey(''); }
        }
      } else if (kind === 'checkout') {
        if (!saved || saved.status !== 'quoted') return;
        if (`${saved.id}:${saved.full_contract_hash}` !== confirmedKey) {
          setConsentKey(''); throw new Error('The price or reading contract changed. Review it and confirm again.');
        }
        await props.beforeCheckout(fileId);
        if (!current()) return;
        const checkout = await payForFullReading(workspaceId, projectId, saved);
        if (current()) { window.location.assign(checkout.url); leavingForCheckout = true; redirecting.current = true; }
      } else if (saved && saved.status !== 'quoted' && saved.status !== 'revoked') {
        if (saved.full_run_id) {
          const value = await getFullTakeoffRun(workspaceId, saved.full_run_id);
          if (current()) rememberRun(value, true);
        } else if (kind === 'start' && saved.status === 'paid' && saved.full_consent_confirmed) {
          const value = await startPurchasedFullReading(workspaceId, projectId, fileId, saved.id);
          if (current()) rememberRun(value, true);
        }
      }
    } catch (error) {
      if (current()) {
        setNotice(errorText(error));
        if (error instanceof ApiError && error.status === 403 && /consent/i.test(errorText(error))) props.onConsentRequired();
      }
    } finally {
      if (!leavingForCheckout) {
        actionLock.current = false;
        if (current()) { setBusy(false); props.onBusyChange(false); setRefresh(value => value + 1); }
        else propsRef.current.onBusyChange(false);
      }
    }
  };

  if (!available && !quote && !returned && !notice && !readError) return null;
  const disabled = !canWrite || busy || props.externallyBusy || !loaded;
  const contractKey = quote ? `${quote.id}:${quote.full_contract_hash}` : '';
  const money = quote ? new Intl.NumberFormat('en-US', { style: 'currency', currency: quote.currency }).format(quote.amount_cents / 100) : '';
  const expired = quote?.status === 'quoted' && Date.parse(quote.expires_at) <= Date.now();
  const presentation = run ? presentFullTakeoffStatus(run) : null;
  return <section className="rounded-xl border border-blue-200 bg-white p-4 space-y-3 min-w-0" aria-label="Full reading purchase">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="font-bold text-slate-900">Read this PDF</h3><p className="text-sm text-slate-600 break-words">{props.fileName} · Revision {props.revisionName}</p></div>
      {quote && <strong className="text-xl text-slate-900">{money}</strong>}
    </div>
    {!expanded && <button type="button" onClick={() => setExpanded(true)} disabled={!canWrite || props.externallyBusy} className="rounded-lg bg-blue-600 text-white px-4 py-2 disabled:opacity-50">Purchase full reading</button>}
    {expanded && <>
      <p className="text-sm text-slate-600">Read every page and see the results and missing information. Confirm the price once; reading starts automatically after payment.</p>
      {!loaded && !notice && !readError && <p role="status" className="text-sm">Loading saved purchase…</p>}
      {returned?.payment === 'canceled' && quote?.status === 'quoted' && <p role="status" className="text-sm">Checkout was canceled. This quote is saved; no reading has started.</p>}
      {quote && <>
        <p className="text-sm">All {quote.full_summary.physicalPageCount} pages · One full reading with saved progress.</p>
        <p className="text-xs text-slate-600">Your {quote.membership === 'standard' ? 'one-time' : quote.membership} price is fixed and includes a conservative processing allowance and service margin. Actual AI processing costs may be lower. This is a one-time purchase.</p>
        <p className="text-sm text-slate-600">The fixed price covers all pages of this PDF. Processing may pause for 24 hours or longer while capacity becomes available, then continue automatically with saved progress and no extra charge. Completion time is not guaranteed.</p>
        <details className="text-xs text-slate-600 break-words"><summary className="cursor-pointer font-semibold">Reading scope and data use</summary>
          <p className="mt-2">AI providers receiving this PDF: {quote.full_summary.providers.map(provider => provider.provider).join(', ')}.</p>
          <p>This purchase covers this saved PDF revision. Quantities, prices and missing details need review. Interrupted work keeps its saved results; uncertain requests are not automatically repeated.</p>
          <p>Cancellation stops new work. Work already performed remains part of the reading.</p>
        </details>
        <p className="text-sm font-medium" role="status">{quote.status === 'quoted' ? returned?.payment === 'returned' ? 'Waiting for Stripe payment confirmation…' : expired ? 'This quote has expired. Refresh the price before checkout.' : 'Awaiting payment' : quote.status === 'revoked' ? 'Payment access revoked. No new reading can start.' : quote.status === 'paid' ? 'Payment confirmed by the server' : quote.status === 'processing' ? 'Purchased reading in progress' : quote.status === 'complete' ? 'Purchased reading ready to review' : 'Purchased reading stopped. Review saved progress.'}</p>
        {presentation && quote.status !== 'revoked' && <p className="text-sm text-slate-600">{presentation.notice}</p>}
        {presentation?.resumeEstimate && quote.status !== 'revoked' && <p className="text-sm text-slate-600">Estimated next processing window: {presentation.resumeEstimate}. This time may change.</p>}
        {quote.status === 'quoted' && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consentKey === contractKey} disabled={disabled || Boolean(expired)} onChange={event => setConsentKey(event.target.checked ? contractKey : '')} /><span>I approve this {money} purchase, sending this PDF to the listed AI providers, and starting this reading automatically after Stripe confirms payment. I accept the reading scope and possible processing waits described above. Results require human review.</span></label>}
        <div className="flex flex-wrap gap-2">
          {quote.status === 'quoted' && <><button type="button" onClick={() => void act('checkout')} disabled={disabled || !props.billingAvailable || consentKey !== contractKey || Boolean(expired)} className="rounded-lg bg-blue-600 text-white px-4 py-2 disabled:opacity-50">{busy ? 'Checking purchase…' : 'Pay securely with Stripe'}</button><button type="button" onClick={() => void act('quote')} disabled={disabled || !available} className="rounded-lg border px-4 py-2 disabled:opacity-50">Refresh full reading price</button></>}
          {quote.status === 'revoked' && !quote.full_run_id && <button type="button" onClick={() => void act('quote')} disabled={disabled || !available} className="rounded-lg border px-4 py-2 disabled:opacity-50">Get a new full reading price</button>}
          {quote.status === 'paid' && !quote.full_run_id && <button type="button" onClick={() => void act('start')} disabled={disabled || !available || !quote.full_consent_confirmed} className="rounded-lg bg-blue-600 text-white px-4 py-2 disabled:opacity-50">{busy ? 'Saving purchased reading…' : 'Start purchased reading'}</button>}
          {quote.full_run_id && quote.status !== 'revoked' && <button type="button" onClick={() => void act('open')} disabled={disabled} className="rounded-lg bg-blue-600 text-white px-4 py-2 disabled:opacity-50">Open purchased reading</button>}
          <button type="button" onClick={() => setRefresh(value => value + 1)} disabled={busy || props.externallyBusy} className="rounded-lg border px-4 py-2 disabled:opacity-50">Refresh purchase status</button>
        </div>
      </>}
      {loaded && !quote && <button type="button" onClick={() => void act('quote')} disabled={disabled || !available} className="rounded-lg bg-blue-600 text-white px-4 py-2 disabled:opacity-50">{busy ? 'Calculating price…' : 'Calculate full reading price'}</button>}
      {!available && <p className="text-sm text-amber-800">New Full readings are temporarily unavailable. Saved purchases and progress remain recoverable.</p>}
      {available && !props.billingAvailable && quote?.status === 'quoted' && <p className="text-sm text-amber-800">Stripe checkout is temporarily unavailable. Your quote remains saved.</p>}
    </>}
    {(notice || readError) && <div role="alert" className="text-sm text-amber-800"><p>{notice || readError}</p><button type="button" onClick={() => { setExpanded(true); setNotice(null); setRefresh(value => value + 1); }} disabled={busy} className="underline mt-1">Retry loading purchase</button></div>}
  </section>;
}
