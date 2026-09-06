import React from 'react';
import { getCapabilities, createBillingCheckout, type BillingPriceKey } from '../services/api';

export const BillingPage: React.FC = () => {
  const [error,setError] = React.useState<string|null>(null);
  const [busy,setBusy] = React.useState(false);
  const [billingAvailable,setBillingAvailable] = React.useState(false);
  React.useEffect(() => { let active=true; getCapabilities().then(value=>{if(active)setBillingAvailable(value.billing);}).catch(()=>undefined); return ()=>{active=false;}; },[]);
  const choose = async (key: BillingPriceKey) => {
    setBusy(true); setError(null);
    try { window.location.assign((await createBillingCheckout(key)).url); }
    catch { setError('Membership checkout is not available yet. Contact support for current plans.'); }
    finally { setBusy(false); }
  };
  return <div className="max-w-5xl mx-auto p-5 sm:p-8 space-y-6">
    <header><h1 className="text-2xl font-bold">Billing & membership</h1><p className="text-slate-600 mt-2">Review plans, enter quantities and costs, and export manually without an AI API.</p></header>
    {!billingAvailable && <section className="rounded-xl bg-blue-50 border border-blue-200 p-5 text-blue-950"><h2 className="font-bold">Manual estimating is available</h2><p className="text-sm mt-2">Paid AI reading and checkout are currently unavailable. No payment is required to use the manual workflow.</p></section>}
    <section className="bg-white border rounded-xl p-5 space-y-2"><h2 className="font-bold">A clear price before you pay</h2>
      <p>Open your project, upload its PDF, and choose Check price & start. Your quote includes the pages, trades and processing attempts covered.</p>
      <p className="text-sm text-slate-600">Creating an account and uploading a plan does not start AI. Memberships do not include unlimited processing.</p></section>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    <section className="grid sm:grid-cols-3 gap-4">{(['starter','pro','team'] as const).map(tier => <article key={tier} className="bg-white border rounded-xl p-5 space-y-3">
      <h2 className="font-bold capitalize text-lg">{tier}</h2><p>Company membership with reduced project prices.</p>
      <p className="text-sm text-slate-600">The company owner manages the subscription. Review the monthly price in checkout before purchasing.</p>
      <button disabled={busy || !billingAvailable} onClick={() => choose(`plan_${tier}`)} className="rounded-lg border px-4 py-2 disabled:opacity-50">{billingAvailable ? 'View membership' : 'Currently unavailable'}</button>
    </article>)}</section>
    <section className="bg-slate-50 border rounded-xl p-5"><h2 className="font-bold">Enterprise</h2><p>Contact support for an agreed scope, company access requirements and custom pricing.</p></section>
    <p className="text-sm text-slate-600">After a payment, return to your project and check payment status. If processing fails twice, contact support for review or a refund.</p>
  </div>;
};
