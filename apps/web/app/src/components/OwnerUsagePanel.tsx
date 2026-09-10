import React, { useEffect, useState } from 'react';
import { supabase } from '../services/supabaseClient';
import { API_BASE_URL } from '../services/api';
import { USAGE_OWNER_EMAIL, USAGE_OWNER_ID, type OwnerUsageReport } from '../../../../../packages/domain/src/api-usage';
const money = (v: number | null) => v === null ? 'Not verified' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(v);
const count = (v: number | null) => v === null ? 'Unknown' : v.toLocaleString('en-US');

/** UI filtering is convenience only. GET /api/owner-usage independently verifies identity and role. */
export function OwnerUsagePanel({ userId, email }: { userId: string; email: string }) {
  const candidate = userId === USAGE_OWNER_ID && email.trim().toLowerCase() === USAGE_OWNER_EMAIL;
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(60);
  const [refresh, setRefresh] = useState(0);
  const [report, setReport] = useState<OwnerUsageReport | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setReport(null); setError('');
    if (!open || !candidate) return;
    if (!supabase) { setError('Owner authentication is not configured. No usage values are available.'); return; }
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let inFlight = false;
    const load = async () => {
      if (disposed || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true; setLoading(true); controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 20000);
      try {
        const session = await Promise.race([
          supabase!.auth.getSession(),
          new Promise<never>((_, reject) => controller!.signal.addEventListener('abort', () => reject(new Error('Usage refresh timed out.')), { once: true })),
        ]);
        if (session.error || !session.data.session || session.data.session.user.id !== userId) throw new Error('Sign in again to verify owner access.');
        const response = await fetch(`${API_BASE_URL}/api/owner-usage?days=${days}`, { headers: { Authorization: `Bearer ${session.data.session.access_token}` }, signal: controller.signal, cache: 'no-store' });
        if ([401, 403].includes(response.status)) { if (!disposed) setReport(null); throw new Error('Owner authorization is required.'); }
        if (!response.ok) throw new Error('Usage could not be verified. Refresh or choose a shorter period.');
        const value = await response.json() as OwnerUsageReport;
        if (!value || !value.totals || !Array.isArray(value.users)) throw new Error('The usage response could not be verified.');
        if (!disposed) { setReport(value); setError(''); }
      } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : 'Usage refresh failed.'); }
      finally { clearTimeout(timeout); inFlight = false; if (!disposed) { setLoading(false); timer = setTimeout(() => { void load(); }, 15000); } }
    };
    const visible = () => { if (document.visibilityState === 'visible') { clearTimeout(timer); void load(); } };
    const auth = supabase.auth.onAuthStateChange((_event, session) => { if (!session || session.user.id !== userId) { controller?.abort(); setReport(null); setOpen(false); } });
    document.addEventListener('visibilitychange', visible); void load();
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visible); auth.data.subscription.unsubscribe(); };
  }, [candidate, userId, open, days, refresh]);
  if (!candidate) return null;
  const t = report?.totals;
  const users = report?.users.filter(u => `${u.name} ${u.email ?? ''} ${u.userId}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <section className="rounded-xl border border-slate-300 bg-white shadow-sm overflow-hidden" aria-label="Owner API usage and cost">
    <button type="button" aria-expanded={open} aria-controls="owner-api-usage" onClick={() => setOpen(v => !v)} className="w-full flex justify-between gap-3 text-left p-5 bg-slate-950 text-white focus-visible:outline-4 focus-visible:outline-blue-500">
      <span><strong className="block text-base">Owner control / API usage & cost</strong><span className="text-xs text-slate-300">Private to your verified RoughBid account</span></span><span>{open ? 'Close' : 'Open'}</span>
    </button>
    {open && <div id="owner-api-usage" className="p-4 sm:p-6 space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="text-sm font-medium">Usage period<select value={days} onChange={e => setDays(Number(e.target.value))} className="block mt-1 rounded border border-slate-300 bg-white p-2">{[7,30,60,90].map(d=><option key={d} value={d}>Last {d} days</option>)}</select></label>
        <div className="text-right text-xs text-slate-600"><p>{report ? `Updated ${new Date(report.generatedAt).toLocaleTimeString()}` : 'Loading verified data...'}</p><p>Refreshes every 15 seconds while open and visible.</p><button type="button" disabled={loading} onClick={()=>setRefresh(v=>v+1)} className="mt-2 rounded border px-3 py-2 font-semibold disabled:opacity-50">{loading ? 'Refreshing...' : 'Refresh now'}</button></div>
      </div>
      {error && <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">{error} {report ? 'Values below are stale, not a current balance.' : ''}</p>}
      {!report && !error && <p role="status" className="py-6 text-slate-600">Verifying identity and loading usage...</p>}
      {report && t && <>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[['Estimated API cost',money(t.estimatedCostUsd),`${t.measuredEvents} measured generation calls; known portion only.`],['Provider-confirmed cost',money(t.actualCostUsd),'Not a live invoice or provider-credit balance.'],['Input / output tokens',`${count(t.inputTokens)} / ${count(t.outputTokens)}`,'Output includes thinking tokens; unknown usage excluded.'],['Recorded API operations',count(t.events),`${t.generationCalls} generation + ${t.tokenCountCalls} token-count calls.`]].map(([label,value,hint])=><div key={label} className="rounded-lg border border-slate-200 p-4"><p className="text-xs uppercase tracking-wide text-slate-600">{label}</p><p className="text-xl font-bold text-slate-950 mt-2 break-words">{value}</p><p className="text-xs text-slate-600 mt-2">{hint}</p></div>)}
        </div>
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"><strong>Accounting coverage</strong><p>{t.unmeteredJobs} jobs without a generation ledger entry; {t.unknownCostEvents} operations with unknown cost; {t.pendingEvents} pending operations. Historical spend is not reconciled. Missing data does not mean zero spend.</p></div>
        <div className="space-y-3"><h3 className="font-bold text-slate-950">Pilot budget / lifetime reservations</h3>{report.cohorts.length === 0 ? <p>No cohort budget found. No allowance is assumed.</p> : report.cohorts.map(c=><div key={c.code} className="rounded-lg border p-4 space-y-2"><div className="flex flex-wrap justify-between gap-2 text-sm"><strong>{c.code}</strong><span>{c.enabled ? 'Enabled' : 'Paused'} / {c.capacity} participants</span></div><p className="text-sm">Reserved {money(c.reservedCents/100)} / limit {money(c.budgetCents/100)} / remaining {money(c.remainingCents/100)}</p><progress className="block w-full" value={Math.min(c.reservedCents,c.budgetCents)} max={c.budgetCents || 1} aria-label={`${c.code} reserved budget`} /><p className="text-xs text-slate-600">Reservations protect the budget; they are not provider charges. These lifetime amounts ignore the period filter.</p>{c.reservationShortfallCents>0 && <p className="text-sm font-semibold text-amber-900">Full 60-day use at 18 projects per participant requires {money(c.maximumReservationCents/100)} in reservations: {money(c.reservationShortfallCents/100)} above this cap. The cap may stop access early; it was not increased.</p>}</div>)}</div>
        <div><div className="flex flex-wrap justify-between items-center gap-3 mb-3"><h3 className="font-bold text-slate-950">Per-user control</h3><label className="text-xs">Find a user<input className="block border rounded p-2 mt-1" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Name, email or user ID" /></label></div>
          <div className="overflow-x-auto"><table className="min-w-full text-sm text-left"><caption className="sr-only">RoughBid API consumption and pilot limits by user</caption><thead className="bg-slate-100"><tr>{['User','Projects / 7 days','AI calls','Tokens in / out','Estimated','Confirmed','Reserved / expires'].map(x=><th key={x} scope="col" className="p-3 whitespace-nowrap">{x}</th>)}</tr></thead><tbody>{users.map(u=><tr key={u.userId} className="border-t align-top"><th scope="row" className="p-3 font-medium"><span className="block">{u.name}</span><span className="block text-xs text-slate-500 break-all">{u.email ?? u.userId}</span><span className="block text-xs text-slate-600">{u.unmeteredJobs} unmetered jobs / {u.unknownCostEvents} unknown costs</span></th><td className="p-3">{u.projectsLimit7d===null ? 'Not enrolled' : `${u.projectsUsed7d} / ${u.projectsLimit7d}`}</td><td className="p-3">{u.generationCalls}<span className="block text-xs">{u.failedJobs} failed jobs</span></td><td className="p-3 whitespace-nowrap">{count(u.inputTokens)} / {count(u.outputTokens)}</td><td className="p-3 whitespace-nowrap">{money(u.estimatedCostUsd)}</td><td className="p-3 whitespace-nowrap">{money(u.actualCostUsd)}</td><td className="p-3 whitespace-nowrap">{u.reservedCents===null ? 'Not enrolled' : money(u.reservedCents/100)}<span className="block text-xs">{u.expiresAt ? new Date(u.expiresAt).toLocaleDateString() : 'No pilot expiry'}</span><span className="block text-xs">{u.accessStatus.replace('_',' ')}</span></td></tr>)}</tbody></table></div>{users.length===0 && <p className="py-4 text-sm text-slate-600">No matching users. No usage is fabricated.</p>}
        </div>
        <div className="border-t pt-3 text-xs text-slate-600 space-y-2"><p>Pilot rules: 60 days; 2 projects in each rolling 7 days; one PDF up to 10 MiB and 10 pages; one AI attempt per project; US$0.25 reserved per attempt; US$5 reservation cap per pilot account. Failed attempts stay counted.</p><p>Owner complimentary access does not make the API free. Owner activity is included here, but the pilot cohort cap does not limit owner calls. Manage pilot revocations under Access invitations.</p><p>{report.coverage.scope}</p></div>
      </>}
    </div>}
  </section>;
}
