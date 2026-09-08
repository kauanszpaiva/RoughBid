import React from 'react';
import { bootstrapAuth, getCapabilities, createBillingCheckout, createBillingPortal, type BillingPriceKey } from '../services/api';

export const BillingPage: React.FC = () => {
  const [error,setError] = React.useState<string|null>(null);
  const [busy,setBusy] = React.useState(false);
  const [billingAvailable,setBillingAvailable] = React.useState(false);
  const [platformAdmin,setPlatformAdmin] = React.useState(false);
  const [memberships,setMemberships] = React.useState({ starter: false, pro: false, team: false });
  const [portalAvailable,setPortalAvailable] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    Promise.all([getCapabilities(), bootstrapAuth()])
      .then(([capabilities, auth]) => {
        if (!active) return;
        setBillingAvailable(capabilities.billing);
        setMemberships({ starter: capabilities.membershipStarter, pro: capabilities.membershipPro, team: capabilities.membershipTeam });
        setPortalAvailable(capabilities.billingPortal);
        setPlatformAdmin(auth.profile.isPlatformAdmin);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const choose = async (key: BillingPriceKey) => {
    if (platformAdmin) return;
    setBusy(true); setError(null);
    try { window.location.assign((await createBillingCheckout(key)).url); }
    catch (error) { setError(error instanceof Error ? error.message : 'Membership checkout is not available yet. Contact support for current plans.'); }
    finally { setBusy(false); }
  };

  const manageBilling = async () => {
    setBusy(true); setError(null);
    try { window.location.assign((await createBillingPortal()).url); }
    catch (error) { setError(error instanceof Error ? error.message : 'The billing portal is unavailable.'); }
    finally { setBusy(false); }
  };

  return <div className="max-w-5xl mx-auto p-5 sm:p-8 space-y-6">
    <header><h1 className="text-2xl font-bold">Billing & membership</h1><p className="text-slate-600 mt-2">Review plans, enter quantities and costs, and export manually without an AI API.</p></header>

    {platformAdmin && <section className="rounded-xl bg-emerald-50 border border-emerald-200 p-5 text-emerald-950 space-y-2">
      <h2 className="font-bold">Complimentary full access</h2>
      <p className="text-sm">This platform-owner account can test paid RoughBid capabilities without purchasing a membership or opening a Stripe checkout.</p>
      <p className="text-xs text-emerald-800">Real AI analysis may still create provider operating cost for KSP; your RoughBid account is not charged.</p>
    </section>}

    {!billingAvailable && !platformAdmin && <section className="rounded-xl bg-blue-50 border border-blue-200 p-5 text-blue-950"><h2 className="font-bold">Manual estimating is available</h2><p className="text-sm mt-2">Paid AI reading and checkout are currently unavailable. No payment is required to use the manual workflow.</p></section>}

    <section className="bg-white border rounded-xl p-5 space-y-2"><h2 className="font-bold">{platformAdmin ? 'Platform owner testing access' : 'A clear price before you pay'}</h2>
      <p>{platformAdmin ? 'Paid product capabilities are included for this testing account. Customer accounts continue through the normal payment and membership flow.' : 'Open your project, upload its PDF, and choose Check price & start. Your quote includes the pages, trades and processing attempts covered.'}</p>
      <p className="text-sm text-slate-600">Creating an account and uploading a plan does not start AI. {platformAdmin ? 'AI plan reading still requires explicit workspace AI-processing consent.' : 'Memberships do not include unlimited processing.'}</p></section>

    {error && <p role="alert" className="text-red-700">{error}</p>}
    <section className="grid sm:grid-cols-3 gap-4">{(['starter','pro','team'] as const).map(tier => <article key={tier} className="bg-white border rounded-xl p-5 space-y-3">
      <h2 className="font-bold capitalize text-lg">{tier}</h2><p>Company membership with reduced project prices.</p>
      <p className="text-sm text-slate-600">{platformAdmin ? 'Included in platform-owner testing access.' : 'The company owner manages the subscription. Review the monthly price in checkout before purchasing.'}</p>
      <button disabled={platformAdmin || busy || !memberships[tier]} onClick={() => choose(`plan_${tier}`)} className="rounded-lg border px-4 py-2 disabled:opacity-50">{platformAdmin ? 'Included' : memberships[tier] ? 'View membership' : 'Currently unavailable'}</button>
    </article>)}</section>
    {!platformAdmin && portalAvailable && <section className="bg-white border rounded-xl p-5 space-y-3"><h2 className="font-bold">Manage an existing membership</h2><p className="text-sm">Update your payment method, view invoices, or cancel through Stripe.</p><button disabled={busy} onClick={manageBilling} className="rounded-lg border px-4 py-2 disabled:opacity-50">Open billing portal</button></section>}
    <section className="bg-slate-50 border rounded-xl p-5"><h2 className="font-bold">Enterprise</h2><p>{platformAdmin ? 'Enterprise commercial feature treatment is included for this platform-owner testing account.' : 'Contact support for an agreed scope, company access requirements and custom pricing.'}</p></section>
    <p className="text-sm text-slate-600">{platformAdmin ? 'No RoughBid membership or project checkout is required for this account. Workspace permissions and AI-processing consent still apply.' : 'After a payment, return to your project and check payment status. If processing fails twice, contact support for review or a refund.'}</p>
  </div>;
};
