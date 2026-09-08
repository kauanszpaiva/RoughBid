import React, { useEffect, useState } from 'react';
import { getPilotAccess, listPilotInvitations, sendPilotInvitations, revokePilotInvitation, type PilotAccess, type PilotInvitation, type PilotPreset } from '../services/api';

const presets: Record<PilotPreset, string> = {
  sample1: 'Sample · 1 project total · 7 days',
  month1: 'Limited month · 1 project / 7 days · 30 days',
  pilot60: 'Pilot · 2 projects / 7 days · 60 days',
};
const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const date = (value?: string | null) => value ? new Date(value).toLocaleDateString() : 'Not activated';

export function PilotAccessPanel({ owner, userId, refreshKey, onBilling }: { owner: boolean; userId: string; refreshKey: number; onBilling(): void }) {
  const [access, setAccess] = useState<PilotAccess | null>(null);
  const [expanded, setExpanded] = useState(owner);
  const [rows, setRows] = useState<PilotInvitation[]>([]);
  const [configured, setConfigured] = useState(false);
  const [remindersConfigured, setRemindersConfigured] = useState(false);
  const [deliveryTrackingConfigured, setDeliveryTrackingConfigured] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [emails, setEmails] = useState('');
  const [preset, setPreset] = useState<PilotPreset>('pilot60');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [budget, setBudget] = useState(12500);

  useEffect(() => {
    let active = true;
    getPilotAccess().then((value) => { if (active) setAccess(value); }).catch(() => { if (active) setAccess(null); });
    return () => { active = false; };
  }, [userId, refreshKey]);
  const reload = async () => {
    try {
      const value = await listPilotInvitations();
      setRows(value.invitations); setConfigured(value.sendingConfigured); setRemindersConfigured(value.remindersConfigured); setDeliveryTrackingConfigured(value.deliveryTrackingConfigured); setBudget(value.cohortBudgetCents); setLoaded(true);
    } catch (error) { setError(error instanceof Error ? error.message : 'Access invitations could not be loaded.'); }
  };
  useEffect(() => { if (owner && expanded) void reload(); }, [owner, expanded, userId]);

  const send = async (addresses: string[], selectedPreset: PilotPreset) => {
    setBusy(true); setError(null); setNotice(null);
    let sent = 0; let skipped = 0; const failed: string[] = [];
    try {
      // One recipient per request leaves each result durable if this browser closes.
      for (const email of addresses) {
        const result = await sendPilotInvitations([email], selectedPreset);
        const row = result.invitations[0];
        if (row?.skipped) skipped += 1;
        else if (row?.email_status === 'sent' || row?.delivery_status === 'sent') sent += 1;
        else failed.push(`${email}: ${row?.error ?? 'Email not confirmed'}`);
      }
      setNotice(`${sent} email${sent === 1 ? '' : 's'} accepted for delivery. ${skipped} existing invitation${skipped === 1 ? '' : 's'} kept unchanged.`);
      if (failed.length) setError(failed.join(' · '));
      else setEmails('');
    } catch (error) { setError(error instanceof Error ? error.message : 'Sending stopped. Refresh the list before retrying.'); }
    finally { await reload(); setBusy(false); }
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const addresses = [...new Set(emails.split(/[\s,;]+/).map((email) => email.trim().toLowerCase()).filter(Boolean))];
    if (!addresses.length || addresses.length > 25 || addresses.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) { setError('Enter 1–25 valid email addresses, separated by commas or new lines.'); return; }
    void send(addresses, preset);
  };
  const copy = async (url: string) => {
    try { await navigator.clipboard.writeText(url); setNotice('Private access link copied. It works only for the invited email.'); }
    catch { setError('Could not copy the link. Please use the email invitation.'); }
  };
  const revoke = async (invitationId: string) => {
    setBusy(true); setError(null);
    try { await revokePilotInvitation(invitationId); setNotice('Limited access revoked. Saved projects are preserved.'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Access could not be revoked.'); }
    finally { await reload(); setBusy(false); }
  };

  if (!owner && !access?.enrolled) return null;
  if (!owner) return <section className="border-b border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-950" aria-label="Limited access status">
    <div className="flex flex-wrap items-center justify-between gap-2"><strong>{access?.active ? 'Your limited access is active' : 'Your limited access has ended'}</strong><button className="text-xs underline font-semibold" onClick={onBilling}>View normal pricing</button></div>
    {access?.active ? <p className="mt-1 text-xs leading-relaxed">Ends {date(access.expires_at)} · {access.projects_remaining_this_week ?? 0} new project{access.projects_remaining_this_week === 1 ? '' : 's'} remaining in your current rolling week. {access.limits?.total_projects ? `${access.limits.total_projects} project total. ` : ''}Each project includes one PDF up to 10 MiB / 10 pages and one AI attempt, subject to the available pilot budget.</p> : <p className="mt-1 text-xs">Your saved projects remain accessible. Future paid use follows normal pricing and requires checkout. No automatic charge is scheduled.</p>}
  </section>;
  const knownCosts = rows.every((row) => typeof row.reserved_cents === 'number');
  const reserved = knownCosts ? rows.reduce((total, row) => total + (row.reserved_cents ?? 0), 0) : null;
  return <section className="border-b border-slate-200 bg-white" aria-label="Owner access dashboard">
    <button className="w-full px-4 py-3 text-left text-sm font-semibold text-blue-700 flex justify-between" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><span>Owner dashboard · Limited access invitations</span><span>{expanded ? 'Close' : 'Manage'}</span></button>
    {expanded && <div className="p-4 sm:p-6 pt-0 space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
        <div className="rounded-lg bg-slate-50 border p-3"><strong>{loaded ? rows.length : '—'} / 25</strong><p className="text-xs text-slate-500 mt-1">Total reserved invitation seats</p></div>
        <div className="rounded-lg bg-slate-50 border p-3"><strong>{loaded && reserved !== null ? money(Math.max(0, budget - reserved)) : 'Awaiting usage data'}</strong><p className="text-xs text-slate-500 mt-1">Available AI budget out of {money(budget)}; conservative reservations included</p></div>
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3"><strong>Your account is complimentary</strong><p className="text-xs text-emerald-800 mt-1">Your access is separate from the 25 users and their API budget.</p></div>
      </div>
      <form onSubmit={submit} className="space-y-3 max-w-3xl">
        <p className="text-xs text-slate-600 leading-relaxed">Each invitation creates a private workspace for that email. Access starts when redeemed. Existing invitations keep their original terms; sending again does not extend access or add another seat. All presets allow one PDF up to 10 MiB / 10 pages and one AI attempt per project, within a $5 user budget and the shared $125 cap.</p>
        <label className="block text-xs font-semibold">Access preset<select value={preset} disabled={busy} onChange={(event) => setPreset(event.target.value as PilotPreset)} className="mt-1 w-full rounded-md border border-slate-300 bg-white p-2 text-sm">{Object.entries(presets).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="block text-xs font-semibold">Email addresses<textarea value={emails} disabled={busy} onChange={(event) => setEmails(event.target.value)} rows={3} placeholder="builder@company.com" className="mt-1 w-full rounded-md border border-slate-300 p-2 text-sm" /></label>
        <p className="text-xs text-slate-500">No card at activation. At expiry, future paid use follows the standard checkout. The final $25 of your $150 ceiling is reserved as a safety margin.</p>
        {loaded && !configured && <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">Invitation sending is not configured yet. Your owner dashboard is available, but email delivery needs to be enabled on the server.</p>}
        <div className="flex flex-wrap gap-3"><button type="submit" disabled={busy || !configured} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Sending invitations…' : 'Send access invitations'}</button><button type="button" disabled={busy} onClick={() => void reload()} className="rounded-md border px-4 py-2 text-sm">Refresh status</button></div>
      </form>
      {notice && <p role="status" className="text-xs text-emerald-800">{notice}</p>}{error && <p role="alert" className="text-xs text-red-700 break-words">{error}</p>}
      <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="border-b"><th className="py-2 pr-3">Email / access</th><th className="py-2 pr-3">Email status</th><th className="py-2 pr-3">Access expires</th><th className="py-2 pr-3">User budget left</th><th className="py-2">Actions</th></tr></thead><tbody>
        {rows.map((row) => <tr key={row.id ?? row.email} className="border-b align-top"><td className="py-3 pr-3"><span className="break-all">{row.email}</span><div className="mt-1 text-slate-500">{row.preset ? presets[row.preset] : 'Limited access'}</div></td><td className="py-3 pr-3">{row.revoked_at ? 'Revoked' : row.accepted_at ? 'Activated' : row.email_delivery_status?.replace('email.', '') ?? row.email_status ?? row.delivery_status ?? 'Pending'}{!row.accepted_at && row.expires_at && <div className="mt-1 text-slate-500">Invitation expires {date(row.expires_at)}</div>}</td><td className="py-3 pr-3">{date(row.enrollment_expires_at)}</td><td className="py-3 pr-3">{typeof row.reserved_cents === 'number' ? money(Math.max(0, (row.budget_cents ?? 500) - row.reserved_cents)) : '—'}</td><td className="py-3 space-y-2">{row.invite_url && <button onClick={() => void copy(row.invite_url!)} className="block text-blue-700 underline">Copy link</button>}{!row.accepted_at && !row.revoked_at && ['pending', 'failed'].includes(row.email_status ?? row.delivery_status ?? 'pending') && <button disabled={busy || !configured} onClick={() => void send([row.email], row.preset ?? 'pilot60')} className="block text-blue-700 underline disabled:opacity-50">Retry email</button>}{row.id && !row.revoked_at && <button disabled={busy} onClick={() => void revoke(row.id!)} className="block text-red-700 underline disabled:opacity-50">Revoke access</button>}</td></tr>)}
        {loaded && rows.length === 0 && <tr><td colSpan={5} className="py-5 text-slate-500">No access invitations created yet.</td></tr>}
      </tbody></table></div>
      <p className="text-[11px] text-slate-500">“Sent” means accepted by the email provider. {deliveryTrackingConfigured ? 'Delivery and bounce events update this dashboard.' : 'Delivery tracking is awaiting setup; check inbox delivery in the email provider dashboard.'} {remindersConfigured ? 'Expiry notices are enabled for seven days before, one day before, and after expiration; the seven-day sample receives the last two notices.' : 'Automatic expiry notices are awaiting setup.'}</p>
    </div>}
  </section>;
}
