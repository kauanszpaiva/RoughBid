import React, { useEffect, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import { createPhotoQuote, getPhotoQuote, payForPhotoQuote, startPurchasedPhotoRun, type PhotoQuote, type PhotoSourceAsset } from '../services/photos-api';
import { readPhotoPurchaseReturn } from '../utils/photoPurchaseReturn';

const message = (error: unknown) => error instanceof Error ? error.message : 'The saved photo purchase could not be checked.';
const statuses = { quoted: 'Review your photo reading', paid: 'Payment confirmed. Preparing your photos…', processing: 'Reading your photos', complete: 'Your photo results are ready to review', failed: 'Your photo results have pending items', revoked: 'This photo purchase is closed' };

/** Selection may calculate a price; only explicit consent can buy or start work. */
export function PhotoPurchasePanel(props: {
  workspaceId: string; projectId: string; assets: PhotoSourceAsset[]; newSelection: boolean;
  canWrite: boolean; purchaseAvailable: boolean; includedAvailable: boolean; workerReady: boolean;
  busy: boolean; actionLock: React.MutableRefObject<boolean>; onBusy: (busy: boolean) => void;
  onIncludedStart: () => Promise<void>; onRunId: (runId: string) => void;
  onConsentRequired: () => void;
}) {
  const target = readPhotoPurchaseReturn(window.location.search);
  const returned = !props.newSelection && target?.workspaceId === props.workspaceId && target.projectId === props.projectId ? target : null;
  const [quote, setQuote] = useState<PhotoQuote | null>(null), [loaded, setLoaded] = useState(false);
  const [consent, setConsent] = useState(''), [error, setError] = useState<string | null>(null), [refresh, setRefresh] = useState(0);
  const [readError, setReadError] = useState<string | null>(null);
  const saved = useRef<PhotoQuote | null>(null), active = useRef(true), request = useRef(0), redirecting = useRef(false);
  const propsRef = useRef(props); propsRef.current = props;
  const context = `${props.workspaceId}:${props.projectId}:${props.assets.map(asset => asset.id).sort().join(',')}`;
  const contextRef = useRef(context); contextRef.current = context;
  const validated = (value: PhotoQuote | null) => {
    if (value && (value.mode !== 'photo_batch' || value.workspace_id !== props.workspaceId || value.project_id !== props.projectId
      || !value.contract_hash || !Number.isSafeInteger(value.amount_cents) || value.amount_cents < 0 || !value.assets.length
      || value.summary.assetCount !== value.assets.length || value.summary.assetIds.length !== value.assets.length
      || new Set(value.summary.assetIds).size !== value.assets.length || value.assets.some(asset => !value.summary.assetIds.includes(asset.id))
      || value.summary.executionPolicy !== 'one-durable-photo-run-budget-wait-no-uncertain-replay'
      || (props.newSelection && value.summary.assetIds.slice().sort().join(',') !== props.assets.map(asset => asset.id).sort().join(',')))) {
      throw new Error('This purchase does not match the selected photos. Refresh before continuing.');
    }
    return value;
  };
  const remember = (value: PhotoQuote | null) => {
    saved.current = value; setQuote(value); setLoaded(true);
    if (value?.run_id && value.status !== 'revoked') propsRef.current.onRunId(value.run_id);
  };
  useEffect(() => {
    active.current = true;
    const back = () => {
      if (!redirecting.current) return;
      redirecting.current = false; propsRef.current.actionLock.current = false;
      propsRef.current.onBusy(false); setRefresh(value => value + 1);
    };
    window.addEventListener('pageshow', back);
    return () => { active.current = false; request.current++; window.removeEventListener('pageshow', back); };
  }, []);
  useEffect(() => {
    if (props.busy) return;
    let current = true, timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const id = ++request.current;
      try {
        const quoteId = saved.current?.id ?? returned?.quoteId;
        let value = validated((await getPhotoQuote(props.workspaceId, props.projectId,
          quoteId ? { quoteId } : props.newSelection ? { assetIds: props.assets.map(asset => asset.id) } : {})).quote);
        if (!current || id !== request.current) return;
        if (quoteId && !value) throw new Error('The saved photo purchase was not found. No replacement was created.');
        if (!value && props.newSelection && props.assets.length && props.purchaseAvailable && !props.includedAvailable) {
          value = validated((await createPhotoQuote(props.workspaceId, props.projectId, props.assets.map(asset => asset.id))).quote);
        }
        if (!current || id !== request.current) return;
        remember(value); setReadError(null);
        if (value && (['paid', 'processing'].includes(value.status) || (value.status === 'quoted' && returned?.payment === 'returned'))) timer = setTimeout(load, 4000);
      } catch (reason) {
        if (!current || id !== request.current) return;
        setReadError(message(reason)); setLoaded(false);
        if (reason instanceof ApiError && reason.status === 403 && /consent/i.test(message(reason))) propsRef.current.onConsentRequired();
        if (!(reason instanceof ApiError && [401, 403, 404].includes(reason.status))) timer = setTimeout(load, 8000);
      }
    };
    void load(); return () => { current = false; if (timer) clearTimeout(timer); };
  }, [context, refresh, props.busy, props.purchaseAvailable, props.includedAvailable]);
  const consentKey = quote ? `${quote.id}:${quote.contract_hash}` : `included:${context}`;
  const act = async (kind: 'checkout' | 'start' | 'refresh') => {
    if (!props.canWrite || props.busy || props.actionLock.current || !loaded) return;
    if ((kind === 'checkout' || (kind === 'start' && !quote)) && consent !== consentKey) return;
    if (!quote && kind === 'start') {
      if (props.includedAvailable && props.workerReady && props.assets.length) await props.onIncludedStart();
      return;
    }
    if (kind !== 'start' && !props.purchaseAvailable) return;
    props.actionLock.current = true; props.onBusy(true); setError(null); request.current++;
    const actionContext = context, current = () => active.current && contextRef.current === actionContext;
    let leaving = false;
    try {
      let value = validated((await getPhotoQuote(props.workspaceId, props.projectId, saved.current ? { quoteId: saved.current.id } : { assetIds: props.assets.map(asset => asset.id) })).quote);
      if (saved.current && !value) throw new Error('The saved purchase could not be checked. Refresh before continuing.');
      if (!current()) return; remember(value);
      if (kind === 'refresh' && (!value || value.status === 'quoted' || (value.status === 'revoked' && !value.run_id))) {
        const assetIds = value?.summary.assetIds ?? props.assets.map(asset => asset.id);
        value = validated((await createPhotoQuote(props.workspaceId, props.projectId, assetIds)).quote);
        if (current()) { remember(value); setConsent(''); }
      } else if (kind === 'checkout' && value?.status === 'quoted') {
        if (`${value.id}:${value.contract_hash}` !== consentKey) { setConsent(''); throw new Error('The photos or price changed. Review this purchase and confirm again.'); }
        const checkout = await payForPhotoQuote(props.workspaceId, props.projectId, value);
        if (current()) { window.location.assign(checkout.url); redirecting.current = true; leaving = true; }
      } else if (kind === 'start' && value?.status === 'paid' && value.consent_confirmed && !value.run_id) {
        const result = await startPurchasedPhotoRun(props.workspaceId, props.projectId, value.id);
        if (current()) propsRef.current.onRunId(result.run.id);
      }
    } catch (reason) { if (current()) { setError(message(reason)); if (reason instanceof ApiError && reason.status === 403 && /consent/i.test(message(reason))) propsRef.current.onConsentRequired(); } }
    finally { if (!leaving) { props.actionLock.current = false; propsRef.current.onBusy(false); if (current()) setRefresh(value => value + 1); } }
  };
  const money = quote ? new Intl.NumberFormat('en-US', { style: 'currency', currency: quote.currency }).format(quote.amount_cents / 100) : '';
  const included = !quote && props.newSelection && props.includedAvailable && props.assets.length > 0;
  const expired = Boolean(quote?.status === 'quoted' && Date.parse(quote.expires_at) <= Date.now());
  const disabled = !props.canWrite || props.busy || !loaded;
  if (loaded && !quote && !props.newSelection && !error && !readError) return null;
  return <section aria-label="Photo reading confirmation" className="rounded-lg border border-blue-200 bg-blue-50/40 p-4 space-y-3">
    <div className="flex flex-wrap justify-between gap-2"><h4 className="font-semibold">{quote ? statuses[quote.status] : 'Confirm your photo reading'}</h4>{quote && <strong>{money}</strong>}{included && <strong>Included with your access</strong>}</div>
    {!loaded && !error && !readError && <p role="status">Checking your saved photos and reading price…</p>}
    {quote && <><p className="text-sm">{quote.summary.assetCount} photos · One saved reading · One payment.</p>
      {returned?.payment === 'returned' && quote.status === 'quoted' && <p role="status">Waiting for payment confirmation…</p>}
      {returned?.payment === 'canceled' && quote.status === 'quoted' && <p role="status">Checkout was canceled. Your photos are saved; no paid reading has started.</p>}
      <p className="text-sm">Reading starts automatically after payment. It may wait 24 hours or longer for capacity, then continue with saved progress and no extra charge. Measurements and prices still need review.</p>
      <details className="text-xs"><summary>Scope and data use</summary><p>The fixed price uses a conservative processing allowance and service margin. Actual processing costs may be lower. The selected photos are shared with these AI services: {quote.summary.providers.map(value => value.provider).join(', ')}. Hidden surfaces and missing dimensions remain pending.</p></details>
    </>}
    {(included || quote?.status === 'quoted') && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent === consentKey} disabled={disabled || expired} onChange={event => setConsent(event.target.checked ? consentKey : '')} /><span>{included ? 'I authorize reading these photos with AI using my included access. I understand that measurements and missing details need review.' : `I approve this ${money} purchase and sharing the selected photos with the listed AI services. Start automatically after payment; I accept the scope and possible processing waits above.`}</span></label>}
    <div className="flex flex-wrap gap-2">
      {included && <button type="button" onClick={() => void act('start')} disabled={disabled || !props.workerReady || consent !== consentKey} className="rounded-md bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50">Read my photos</button>}
      {quote?.status === 'quoted' && <><button type="button" onClick={() => void act('checkout')} disabled={disabled || !props.purchaseAvailable || expired || consent !== consentKey} className="rounded-md bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50">Pay securely with Stripe</button><button type="button" onClick={() => void act('refresh')} disabled={disabled || !props.purchaseAvailable} className="text-sm underline">Refresh price</button></>}
      {quote?.status === 'revoked' && !quote.run_id && <button type="button" onClick={() => void act('refresh')} disabled={disabled || !props.purchaseAvailable} className="text-sm underline">Get a new photo reading price</button>}
      {quote?.status === 'paid' && quote.consent_confirmed && !quote.run_id && <button type="button" onClick={() => void act('start')} disabled={disabled || !props.workerReady} className="text-sm underline">Resume purchased photo reading</button>}
      {(quote || error || readError) && <button type="button" onClick={() => { setError(null); setReadError(null); setRefresh(value => value + 1); }} disabled={props.busy} className="text-sm underline">Refresh saved purchase</button>}
    </div>
    {expired && <p className="text-sm">This price expired. Refresh it before paying.</p>}
    {!quote && !props.includedAvailable && !props.purchaseAvailable && <p className="text-sm">New photo readings are temporarily unavailable. Your saved photos and results remain accessible.</p>}
    {(error || readError) && <p role="alert" className="text-sm text-amber-900">{error || readError}</p>}
  </section>;
}
