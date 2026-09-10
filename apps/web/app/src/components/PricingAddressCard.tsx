import React, { useState } from "react";
import type { PricingContext, PlanProjectAddressEvidence } from "../services/api";

export type PricingAddressChoice = "plan" | "project";

type PricingAddressCardProps = {
  context: PricingContext | null;
  canWrite: boolean;
  error?: string | null;
  onResolve: (choice: PricingAddressChoice) => Promise<void>;
};

function planAddressText(plan: PlanProjectAddressEvidence | null): string {
  if (!plan) return "Not available";
  return [plan.street_address, plan.building_lot_unit, plan.city, plan.state, plan.postal_code]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(", ") || "Not available";
}

function pricingAddressText(context: PricingContext): string {
  const address = context.pricing_address;
  if (!address) return "Not resolved";
  if (typeof address.formatted === "string" && address.formatted.trim()) return address.formatted.trim();
  return [address.street_address, address.building_lot_unit, address.city, address.state, address.postal_code]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .join(", ") || "Not resolved";
}

function sourceLabel(context: PricingContext): string {
  if (context.address_source === "confirmed_override") return "Human confirmed";
  if (context.address_source === "plan") return "Plan evidence";
  if (context.address_source === "project") return "Project record";
  return "Unresolved";
}

export const PricingAddressCard: React.FC<PricingAddressCardProps> = ({ context, canWrite, error, onResolve }) => {
  const [busyChoice, setBusyChoice] = useState<PricingAddressChoice | null>(null);

  const resolve = async (choice: PricingAddressChoice) => {
    if (!canWrite || busyChoice) return;
    setBusyChoice(choice);
    try {
      await onResolve(choice);
    } finally {
      setBusyChoice(null);
    }
  };

  if (!context) {
    return (
      <section className="mx-auto max-w-6xl px-4 sm:px-6 md:px-8 pt-4" aria-label="Pricing address">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-bold text-slate-900">Pricing address</h3>
            <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-600">Comparison pending</span>
          </div>
          <p className="mt-2 text-xs text-slate-600">Plan analysis will compare any evidenced address with the saved project address. You can enter verified costs manually in your estimate now.</p>
          {error && <p className="mt-2 text-xs text-rose-700">{error}</p>}
        </div>
      </section>
    );
  }

  if (context.address_status === "needs_resolution") {
    return (
      <section className="mx-auto max-w-6xl px-4 sm:px-6 md:px-8 pt-4" aria-label="Pricing address">
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Pricing address conflict</h3>
              <p className="mt-1 text-xs text-amber-900">Pricing is blocked until an estimator confirms which address should drive regional pricing.</p>
            </div>
            <span className="rounded-full bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-900">Needs resolution</span>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-amber-200 bg-white p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Plan address</div>
              <div className="mt-1 text-sm font-semibold text-slate-900">{planAddressText(context.plan_address)}</div>
              {context.plan_address && <div className="mt-1 text-[11px] text-slate-500">Page {context.plan_address.page_number} · {Math.round(context.plan_address.confidence * 100)}% evidence confidence</div>}
            </div>
            <div className="rounded-lg border border-amber-200 bg-white p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Project address</div>
              <div className="mt-1 text-sm font-semibold text-slate-900">{context.project_address_text?.trim() || "Not available"}</div>
            </div>
          </div>
          {canWrite ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={() => void resolve("plan")} disabled={Boolean(busyChoice) || !context.plan_address} className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
                {busyChoice === "plan" ? "Confirming…" : "Use plan address"}
              </button>
              <button type="button" onClick={() => void resolve("project")} disabled={Boolean(busyChoice) || !context.project_address_text?.trim()} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 disabled:opacity-50">
                {busyChoice === "project" ? "Confirming…" : "Keep project address"}
              </button>
            </div>
          ) : (
            <p className="mt-3 text-xs text-amber-900">An Admin or Estimator must resolve this conflict before pricing can continue.</p>
          )}
          {error && <p className="mt-2 text-xs text-rose-700">{error}</p>}
        </div>
      </section>
    );
  }

  if (context.address_status === "missing") {
    return (
      <section className="mx-auto max-w-6xl px-4 sm:px-6 md:px-8 pt-4" aria-label="Pricing address">
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
          <h3 className="text-sm font-bold text-slate-900">Pricing address missing</h3>
          <p className="mt-1 text-xs text-rose-800">Pricing cannot start until a project address is available or the plan provides evidenced address data.</p>
          {error && <p className="mt-2 text-xs text-rose-700">{error}</p>}
        </div>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-6xl px-4 sm:px-6 md:px-8 pt-4" aria-label="Pricing address">
      <div className="rounded-xl border border-emerald-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Pricing address</h3>
            <p className="mt-1 text-sm font-semibold text-slate-900">{pricingAddressText(context)}</p>
          </div>
          <div className="text-right">
            <span className="rounded-full bg-emerald-100 px-2 py-1 text-[11px] font-semibold text-emerald-800">{context.address_status === "resolved" ? "Confirmed" : "Clear"}</span>
            <div className="mt-2 text-[11px] text-slate-500">Source: {sourceLabel(context)}</div>
          </div>
        </div>
        {context.plan_address && <p className="mt-2 text-[11px] text-slate-500">Plan evidence: page {context.plan_address.page_number} · “{context.plan_address.source_excerpt}”</p>}
        {error && <p className="mt-2 text-xs text-rose-700">{error}</p>}
      </div>
    </section>
  );
};
