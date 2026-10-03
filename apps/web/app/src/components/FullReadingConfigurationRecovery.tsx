import React, { useEffect, useState } from 'react';
import { getAiPlanEntitlement, type FullTakeoffApprovalProfile, type FullTakeoffSpendInput } from '../services/api';
import { fullTakeoffSpendInput } from '../utils/fullTakeoffApproval';

export function FullReadingConfigurationRecovery({ workspaceId, projectId, busy, onApprove }: {
  workspaceId: string; projectId: string; busy: boolean; onApprove: (approval: FullTakeoffSpendInput) => void;
}) {
  const [profile, setProfile] = useState<FullTakeoffApprovalProfile | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setProfile(null); setAmounts({}); setConfirmed(false); setError(null);
    getAiPlanEntitlement(workspaceId, projectId).then(result => {
      if (!active) return;
      if (!result.fullTakeoffV2Available || !result.fullTakeoffApproval) {
        setError('Processing is temporarily unavailable. Your PDF is saved. Check again after the service is ready.');
        return;
      }
      setProfile(result.fullTakeoffApproval);
    }).catch(() => { if (active) setError('Could not load the current processing settings. Check again.'); });
    return () => { active = false; };
  }, [workspaceId, projectId, refresh]);
  const approval = fullTakeoffSpendInput(profile, amounts, confirmed);
  return <section aria-label="Recover plan reading" className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-3">
    <h4 className="font-semibold">Review settings and retry this PDF</h4>
    <p>The reading stopped during setup. Review the current providers and limits before retrying. Your original PDF stays saved.</p>
    {!profile && !error && <p role="status">Loading current processing settings…</p>}
    {error && <p role="alert">{error}</p>}
    {profile?.providers.map(provider => <label key={provider.provider} className="block text-sm">
      <span>{provider.provider} · {provider.models.join(', ')} · USD {provider.minimumUsd}–{provider.maximumUsd}</span>
      <input aria-label={`${provider.provider} retry spending limit USD`} type="number" min={provider.minimumUsd} max={provider.maximumUsd} step="0.000001"
        value={amounts[provider.provider] ?? ''} disabled={busy} className="ml-2 rounded border px-2 py-1"
        onChange={event => { setAmounts(previous => ({...previous,[provider.provider]:event.target.value})); setConfirmed(false); }} />
    </label>)}
    {profile && <label className="block text-sm"><input type="checkbox" checked={confirmed} disabled={busy}
      onChange={event => setConfirmed(event.target.checked)} /> I approve these providers and spending limits for this saved PDF.</label>}
    <div className="flex flex-wrap gap-3">
      <button type="button" disabled={busy || !approval} onClick={() => { if (approval) onApprove(approval); }} className="rounded border px-3 py-2 disabled:opacity-50">{busy ? 'Retrying…' : 'Approve settings and retry reading'}</button>
      <button type="button" disabled={busy} onClick={() => setRefresh(value => value + 1)} className="underline disabled:opacity-50">Check processing settings again</button>
    </div>
  </section>;
}
