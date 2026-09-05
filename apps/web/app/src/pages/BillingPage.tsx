import React from "react";
import { AlertTriangle, Check, CreditCard, Database, FolderKanban, ShieldCheck, Sparkles } from "lucide-react";
import {
  MINIMUM_GROSS_MARGIN_PERCENT,
  ROUGHBID_COMMERCIAL_PLANS,
  ROUGHBID_MARKETPLACE_FEEDS,
  ROUGHBID_PLAN_LIMITS,
  ROUGHBID_PROJECT_SIZE_PRICES,
  ROUGHBID_TRIAL_CREDITS,
  TRIAL_COGS_HARD_CAP_USD,
  calculateSizedProjectUnitEconomics,
  marketplaceFeedEconomics,
  projectPriceForSize,
} from "../../../../../packages/domain/src/billing.ts";
import { createBillingCheckout, type BillingPriceKey } from "../services/api";

const formatMoney = (value: number) => `$${value.toFixed(value % 1 === 0 ? 0 : 2)}`;

const planIds = Object.keys(ROUGHBID_COMMERCIAL_PLANS) as Array<keyof typeof ROUGHBID_COMMERCIAL_PLANS>;
const projectSizeIds = Object.keys(ROUGHBID_PROJECT_SIZE_PRICES) as Array<keyof typeof ROUGHBID_PROJECT_SIZE_PRICES>;
const feedIds = Object.keys(ROUGHBID_MARKETPLACE_FEEDS) as Array<keyof typeof ROUGHBID_MARKETPLACE_FEEDS>;

export const BillingPage: React.FC = () => {
  const [checkoutState, setCheckoutState] = React.useState<"idle" | "loading" | "error">("idle");
  const [checkoutError, setCheckoutError] = React.useState<string | null>(null);

  const startCheckout = async (priceKey: BillingPriceKey) => {
    setCheckoutState("loading");
    setCheckoutError(null);
    try {
      const session = await createBillingCheckout(priceKey);
      window.location.assign(session.url);
    } catch (error) {
      setCheckoutState("error");
      setCheckoutError(error instanceof Error ? error.message : "Checkout is not configured yet.");
    }
  };

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-7xl mx-auto space-y-6 select-none font-sans">
      <section className="bg-white border border-slate-200 rounded-lg p-5 sm:p-6 shadow-xs">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-blue-600">Commercial model</p>
            <h1 className="text-xl sm:text-2xl font-extrabold text-slate-900 tracking-tight mt-1">Billing & Usage</h1>
            <p className="text-xs text-slate-500 mt-1 max-w-2xl">
              RoughBid charges per project, then subscriptions lower each project price. Marketplace feeds stay separate paid add-ons.
            </p>
          </div>
          <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-800">
            <div className="font-bold">{MINIMUM_GROSS_MARGIN_PERCENT}%+ margin guardrail</div>
            <div>Trial COGS cap: {formatMoney(TRIAL_COGS_HARD_CAP_USD)} per user</div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-5">
          <div className="rounded-md bg-slate-50 border border-slate-200 p-3">
            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <Sparkles className="w-3.5 h-3.5 text-blue-600" />
              Free trial
            </div>
            <p className="text-xl font-black text-slate-900 mt-1">{ROUGHBID_TRIAL_CREDITS} projects</p>
            <p className="text-[11px] text-slate-500">No card, hard capped provider spend.</p>
          </div>
          <div className="rounded-md bg-slate-50 border border-slate-200 p-3">
            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <FolderKanban className="w-3.5 h-3.5 text-blue-600" />
              Project pricing
            </div>
            <p className="text-xl font-black text-slate-900 mt-1">By size</p>
            <p className="text-[11px] text-slate-500">Small, standard, large, complex.</p>
          </div>
          <div className="rounded-md bg-slate-50 border border-slate-200 p-3">
            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <Database className="w-3.5 h-3.5 text-blue-600" />
              Marketplace
            </div>
            <p className="text-xl font-black text-slate-900 mt-1">Add-ons</p>
            <p className="text-[11px] text-slate-500">Regional data, codes, labor, supplier imports.</p>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {planIds.map((planId) => {
          const plan = ROUGHBID_COMMERCIAL_PLANS[planId];
          const limits = ROUGHBID_PLAN_LIMITS[planId];
          return (
            <div key={plan.id} className="bg-white border border-slate-200 rounded-lg p-5 shadow-xs flex flex-col">
              <div className="flex items-start justify-between gap-3">
                <div className="w-10 h-10 rounded-md bg-blue-50 text-blue-700 flex items-center justify-center">
                  <CreditCard className="w-4 h-4" />
                </div>
                <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-[10px] font-bold uppercase">
                  {plan.projectDiscountPercent}% project discount
                </span>
              </div>
              <h2 className="text-lg font-black text-slate-900 mt-4">{plan.name}</h2>
              <div className="mt-1 flex items-baseline gap-1">
                <span className="text-3xl font-black text-slate-900">{formatMoney(plan.priceUsd)}</span>
                <span className="text-xs text-slate-500">/ month</span>
              </div>
              <div className="mt-4 space-y-2 text-xs text-slate-600 flex-1">
                <div className="flex justify-between gap-3"><span>Seats</span><strong>{limits.seats}</strong></div>
                <div className="flex justify-between gap-3"><span>Active projects</span><strong>{limits.activeProjects}</strong></div>
                <div className="flex justify-between gap-3"><span>PDF cap</span><strong>{limits.maxPdfMb} MB</strong></div>
                <div className="flex justify-between gap-3"><span>AI passes/project</span><strong>{limits.aiGenerationsPerProject}</strong></div>
                <div className="flex justify-between gap-3"><span>Client links/month</span><strong>{limits.clientProposalLinksPerMonth}</strong></div>
              </div>
              <button
                type="button"
                onClick={() => startCheckout(`plan_${plan.id}` as BillingPriceKey)}
                disabled={checkoutState === "loading"}
                className="mt-5 w-full h-10 rounded-md bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-xs font-bold flex items-center justify-center gap-1.5"
                title="Starts Stripe Checkout when the approved RoughBid price ID is configured."
              >
                <CreditCard className="w-3.5 h-3.5" />
                {checkoutState === "loading" ? "Opening checkout..." : "Choose plan"}
              </button>
            </div>
          );
        })}
      </section>

      {checkoutState === "error" && checkoutError && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          <strong>Checkout is not live yet.</strong> {checkoutError}
        </div>
      )}

      <section className="bg-white border border-slate-200 rounded-lg overflow-hidden shadow-xs">
        <div className="px-5 py-4 border-b border-slate-200">
          <h2 className="text-sm font-bold text-slate-900">Per-project charges</h2>
          <p className="text-xs text-slate-500 mt-0.5">Prices are low-friction but still tested against provider COGS and card fees.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-xs">
            <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider">
              <tr>
                <th className="px-5 py-3 text-left font-bold">Project size</th>
                <th className="px-5 py-3 text-right font-bold">Base</th>
                {planIds.map((planId) => <th key={planId} className="px-5 py-3 text-right font-bold">{ROUGHBID_COMMERCIAL_PLANS[planId].name}</th>)}
                <th className="px-5 py-3 text-right font-bold">COGS cap</th>
                <th className="px-5 py-3 text-right font-bold">Margin</th>
                <th className="px-5 py-3 text-right font-bold">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {projectSizeIds.map((sizeId) => {
                const size = ROUGHBID_PROJECT_SIZE_PRICES[sizeId];
                const baseEconomics = calculateSizedProjectUnitEconomics(size);
                return (
                  <tr key={size.id}>
                    <td className="px-5 py-3">
                      <div className="font-bold text-slate-900">{size.name}</div>
                      <div className="text-[11px] text-slate-500">{size.maxPlanPages} pages max · {size.aiGenerations} AI passes</div>
                    </td>
                    <td className="px-5 py-3 text-right font-mono font-bold text-slate-900">{formatMoney(size.basePriceUsd)}</td>
                    {planIds.map((planId) => (
                      <td key={`${size.id}-${planId}`} className="px-5 py-3 text-right font-mono text-slate-700">
                        {formatMoney(projectPriceForSize(size, ROUGHBID_COMMERCIAL_PLANS[planId]))}
                      </td>
                    ))}
                    <td className="px-5 py-3 text-right font-mono text-slate-700">{formatMoney(size.reviewCapUsd)}</td>
                    <td className="px-5 py-3 text-right">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-bold">
                        <Check className="w-3 h-3" />
                        {baseEconomics.grossMarginPercent.toFixed(0)}%
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => startCheckout(`project_${size.id}` as BillingPriceKey)}
                        disabled={checkoutState === "loading"}
                        className="px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-60 font-semibold"
                      >
                        Buy project
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-5 shadow-xs">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-blue-600" />
            <h2 className="text-sm font-bold text-slate-900">Usage rules</h2>
          </div>
          <ul className="mt-4 space-y-2 text-xs text-slate-600">
            <li>Every project has its own credit status and AI usage cap.</li>
            <li>Customer plans, estimates, signatures, and price books remain separated by workspace.</li>
            <li>Cheap AI providers can be used only inside the project COGS cap; higher-cost review is reserved for verification.</li>
            <li>Client proposal links do not require a client account and are tracked for open/sign notifications.</li>
          </ul>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5 shadow-xs">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            <h2 className="text-sm font-bold text-slate-900">Activation gates</h2>
          </div>
          <ul className="mt-4 space-y-2 text-xs text-slate-600">
            <li>Stripe checkout stays disabled until live products, prices, tax behavior, and refund rules are approved.</li>
            <li>Regional code and price feeds must keep source URLs, effective dates, and estimator approval before use in proposals.</li>
            <li>Legal policies remain working drafts until reviewed for the operating entity and target jurisdictions.</li>
          </ul>
        </div>
      </section>

      <section className="bg-white border border-slate-200 rounded-lg overflow-hidden shadow-xs">
        <div className="px-5 py-4 border-b border-slate-200">
          <h2 className="text-sm font-bold text-slate-900">Marketplace add-ons</h2>
          <p className="text-xs text-slate-500 mt-0.5">Separate paid data products that can be connected to estimates after licensing.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-0 divide-y md:divide-y-0 md:divide-x divide-slate-100">
          {feedIds.map((feedId) => {
            const feed = ROUGHBID_MARKETPLACE_FEEDS[feedId];
            const economics = marketplaceFeedEconomics(feed);
            return (
              <div key={feed.id} className="p-5">
                <div className="text-[10px] font-bold uppercase tracking-wider text-blue-600">{feed.includedRegions.join(", ")}</div>
                <h3 className="text-sm font-black text-slate-900 mt-1">{feed.name}</h3>
                <p className="text-2xl font-black text-slate-900 mt-3">{formatMoney(feed.priceUsd)}<span className="text-xs font-semibold text-slate-500">/mo</span></p>
                <p className="text-xs text-slate-500 mt-2">Estimated margin: {economics.grossMarginPercent.toFixed(0)}%</p>
                <button
                  type="button"
                  onClick={() => startCheckout(`marketplace_${feed.id}` as BillingPriceKey)}
                  disabled={checkoutState === "loading"}
                  className="mt-4 w-full px-3 py-2 rounded-md border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                >
                  Add feed
                </button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
};
