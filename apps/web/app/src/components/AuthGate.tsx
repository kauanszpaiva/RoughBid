import React, { useState } from "react";
import {
  ArrowRight,
  BrainCircuit,
  Check,
  CheckCircle2,
  Database,
  FileWarning,
  LockKeyhole,
  Loader2,
  Mail,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { isAuthConfigured } from "../services/supabaseClient";
import { requestMagicLink } from "../services/api";

type AuthMode = "sign-in" | "create-account";
type SendState = "idle" | "sending" | "sent" | "error";

export const AuthGate: React.FC = () => {
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [email, setEmail] = useState("");
  const [state, setState] = useState<SendState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [reviewDecision, setReviewDecision] = useState<"pending" | "approved" | "rejected">("pending");

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isAuthConfigured) {
      setState("error");
      setError("Sign-in is not configured in this environment. Production needs Supabase Auth variables before app access.");
      return;
    }

    setState("sending");
    setError(null);
    const inviteToken = new URLSearchParams(window.location.search).get("invite");
    const pilotInviteToken = new URLSearchParams(window.location.search).get("pilot_invite");
    try {
      await requestMagicLink({ email: email.trim(), inviteToken, pilotInviteToken, mode });
      setState("sent");
    } catch (error) {
      setState("error");
      setError(error instanceof Error ? error.message : "We could not send your sign-in link. Try again.");
    }
  };

  return (
    <main className="min-h-screen bg-[#f8fafc] px-4 py-8 sm:px-6 lg:py-12 font-sans text-slate-900">
      <div className="w-full max-w-[1180px] mx-auto">
        <div className="text-center mb-5">
          <img src="/brand/roughbid-logo.png" alt="RoughBid" className="w-60 max-w-full h-16 mx-auto object-contain" />
          <h1 className="sr-only">RoughBid</h1>
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500 mt-3">
            Construction estimating & takeoff platform
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl shadow-xs p-4 sm:p-5 max-w-[440px] mx-auto">
          {new URLSearchParams(window.location.search).has('pilot_invite') && <p className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs leading-relaxed text-blue-900">You have an access invitation. Sign in or create your account using the exact email that received it. Your private workspace and access period activate after your email is verified.</p>}
          <div className="grid grid-cols-2 bg-slate-100 rounded-lg p-1 mb-5">
            <button
              type="button"
              onClick={() => {
                setMode("sign-in");
                setState("idle");
                setError(null);
              }}
              className={`h-9 rounded-md text-xs font-bold transition ${mode === "sign-in" ? "bg-white text-slate-900 shadow-xs" : "text-slate-500"}`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("create-account");
                setState("idle");
                setError(null);
              }}
              className={`h-9 rounded-md text-xs font-bold transition ${mode === "create-account" ? "bg-white text-slate-900 shadow-xs" : "text-slate-500"}`}
            >
              Create Account
            </button>
          </div>

          {state === "sent" ? (
            <div className="border border-blue-200 bg-blue-50 rounded-lg p-4 text-sm">
              <div className="flex items-center gap-2 font-bold text-blue-950">
                <Mail className="w-4 h-4 text-blue-600" />
                Check your email
              </div>
              <p className="text-blue-800 text-xs leading-relaxed mt-2">
                Check the inbox and spam folder for <strong>{email}</strong>. If your request can be completed, a secure RoughBid link will arrive. Open it on this device to {mode === "create-account" ? "finish creating your account" : "enter your workspace"}.
              </p>
              <button
                type="button"
                onClick={() => setState("idle")}
                className="mt-4 w-full h-10 border border-blue-200 bg-white text-blue-700 rounded-md text-xs font-bold hover:bg-blue-50"
              >
                Use another email
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {!isAuthConfigured && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                  App access is locked until Supabase Auth is configured for this environment.
                </div>
              )}

              <label className="block">
                <span className="text-[11px] font-bold text-slate-700">Email Address</span>
                <div className="mt-1.5 relative">
                  <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@company.com"
                    className="w-full h-10 pl-9 pr-3 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              </label>

              <p className="text-xs text-slate-500 leading-relaxed">No password to remember. We will email you a secure link to open your workspace.</p>

              {error && <p role="alert" className="text-xs text-red-600">{error}</p>}

              <button
                type="submit"
                disabled={state === "sending" || !isAuthConfigured}
                className="w-full h-10 rounded-md bg-blue-600 hover:bg-blue-700 disabled:opacity-70 text-white text-sm font-bold flex items-center justify-center gap-2 transition"
              >
                {state === "sending" ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                <span>{mode === "sign-in" ? "Sign In to Workspace" : "Create RoughBid Account"}</span>
              </button>
            </form>
          )}

          <div className="mt-4 rounded-lg border border-blue-100 bg-blue-50 p-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <ShieldCheck className="w-4 h-4 text-blue-600 shrink-0" />
              <div className="min-w-0">
                <div className="text-[11px] font-bold uppercase tracking-wider text-blue-900">Secure workspace access</div>
                <p className="text-[11px] text-blue-700 leading-relaxed">Your projects are private. Review and estimate manually without an AI API.</p>
              </div>
            </div>
          </div>
        </div>

        <p className="text-center text-[11px] text-slate-500 mt-5">
          RoughBid is an independent SaaS for construction estimating, plan review, project pricing, and client proposals.
        </p>

        <section aria-labelledby="estimating-comparison-title" className="mt-16 sm:mt-24 pb-8">
          <div className="text-center max-w-2xl mx-auto">
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-blue-700">
              <Sparkles className="h-3.5 w-3.5" /> A better estimating workflow
            </div>
            <h2 id="estimating-comparison-title" className="mt-5 text-3xl sm:text-4xl font-black tracking-tight text-slate-950">
              AI speed. Estimator control.
            </h2>
            <p className="mt-3 text-sm sm:text-base leading-relaxed text-slate-600">
              Move beyond fragile spreadsheets without handing final judgment to a black box. RoughBid structures the work, surfaces gaps, and keeps every decision with you.
            </p>
          </div>

          <div className="mt-10 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_18px_60px_-32px_rgba(15,23,42,0.35)]">
            <div className="grid grid-cols-[1fr_1fr] border-b border-slate-200 bg-slate-50 sm:grid-cols-[0.72fr_1fr_1fr]">
              <div className="hidden p-5 sm:block" />
              <div className="border-r border-slate-200 p-4 sm:p-5">
                <div className="flex items-center gap-2 text-sm font-extrabold text-red-800"><FileWarning className="h-4 w-4" /> Spreadsheet Chaos</div>
                <p className="mt-1 text-[11px] text-red-600">Manual & fragmented</p>
              </div>
              <div className="p-4 sm:p-5">
                <div className="flex items-center gap-2 text-sm font-extrabold text-emerald-800"><CheckCircle2 className="h-4 w-4" /> RoughBid Workspace</div>
                <p className="mt-1 text-[11px] text-emerald-600">Structured & human-reviewed</p>
              </div>
            </div>
            {[
              ["Plan review", "Scan every sheet by hand", "AI-assisted gap detection"],
              ["Line items", "Copy, paste, and chase cells", "One structured estimate"],
              ["Quality control", "Hidden formula errors", "Review before anything is added"],
              ["Calculation", "Rounding drift across tabs", "Exact precision math"],
            ].map(([label, oldWay, roughBid], index) => (
              <div key={label} className={`grid grid-cols-[1fr_1fr] sm:grid-cols-[0.72fr_1fr_1fr] ${index < 3 ? "border-b border-slate-100" : ""}`}>
                <div className="col-span-2 bg-slate-50/60 px-4 pt-4 text-[10px] font-extrabold uppercase tracking-widest text-slate-500 sm:col-span-1 sm:bg-white sm:p-5 sm:text-xs sm:normal-case sm:tracking-normal sm:text-slate-800">{label}</div>
                <div className="flex items-center gap-2 border-r border-slate-100 px-4 pb-4 pt-2 text-xs leading-relaxed text-slate-600 sm:p-5 sm:text-sm"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600"><X className="h-3 w-3" /></span>{oldWay}</div>
                <div className="flex items-center gap-2 px-4 pb-4 pt-2 text-xs font-semibold leading-relaxed text-slate-800 sm:p-5 sm:text-sm"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600"><Check className="h-3 w-3" /></span>{roughBid}</div>
              </div>
            ))}
          </div>

          <div className="mt-8 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="rounded-2xl border border-slate-200 bg-slate-950 p-5 text-white shadow-xl sm:p-7">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-blue-300"><BrainCircuit className="h-4 w-4" /> AI review queue</div>
                  <h3 className="mt-2 text-xl font-bold">A suggestion—not an automatic change.</h3>
                </div>
                <span className="rounded-full bg-white/10 px-2.5 py-1 text-[10px] font-bold text-slate-300">1 finding</span>
              </div>
              <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.06] p-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2 rounded-full bg-amber-400/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-300"><FileWarning className="h-3 w-3" /> Possible missing item</span>
                  <span className="text-[11px] text-slate-400">Sheet A5.2 · Detail 7</span>
                </div>
                <div className="mt-4 flex items-start justify-between gap-4">
                  <div><p className="font-bold">Exterior door flashing</p><p className="mt-1 text-xs leading-relaxed text-slate-400">Shown in wall detail but not found in your estimate.</p></div>
                  <div className="text-right"><p className="font-mono text-sm font-bold">12 LF</p><p className="text-[10px] text-slate-500">AI quantity</p></div>
                </div>
                <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-white/10 pt-4">
                  {reviewDecision === "pending" ? <>
                    <button type="button" onClick={() => setReviewDecision("approved")} className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500 px-4 py-2 text-xs font-extrabold text-white hover:bg-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-300"><Check className="h-3.5 w-3.5" /> Approve</button>
                    <button type="button" onClick={() => setReviewDecision("rejected")} className="inline-flex items-center gap-1.5 rounded-full border border-white/20 px-4 py-2 text-xs font-extrabold text-slate-200 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/40"><X className="h-3.5 w-3.5" /> Reject</button>
                    <span className="ml-auto text-[11px] text-slate-500">No changes without your approval</span>
                  </> : <div role="status" className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs font-bold ${reviewDecision === "approved" ? "bg-emerald-400/15 text-emerald-300" : "bg-slate-700 text-slate-300"}`}>
                    <span>{reviewDecision === "approved" ? "Approved and added to estimate" : "Rejected — estimate unchanged"}</span>
                    <button type="button" onClick={() => setReviewDecision("pending")} className="underline underline-offset-2 hover:text-white">Undo</button>
                  </div>}
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50 to-white p-5 sm:p-7">
              <p className="text-xs font-extrabold uppercase tracking-widest text-blue-700">Built for accountable estimates</p>
              <div className="mt-5 space-y-5">
                {[
                  [LockKeyhole, "Private project data", "Workspace access is secured and your project files stay private."],
                  [ShieldCheck, "Human in the loop", "AI findings wait for an estimator to approve or reject them."],
                  [Database, "Exact precision math", "Totals use deterministic calculations—not AI-generated arithmetic."],
                ].map(([Icon, title, copy]) => {
                  const TrustIcon = Icon as React.ComponentType<{ className?: string }>;
                  return <div key={title as string} className="flex gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-blue-100 bg-white text-blue-700 shadow-sm"><TrustIcon className="h-5 w-5" /></span><div><h3 className="text-sm font-extrabold text-slate-900">{title as string}</h3><p className="mt-1 text-xs leading-relaxed text-slate-600">{copy as string}</p></div></div>;
                })}
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
};
