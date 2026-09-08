import React, { useState } from "react";
import { ArrowRight, Loader2, Mail, ShieldCheck } from "lucide-react";
import { isAuthConfigured } from "../services/supabaseClient";
import { requestMagicLink } from "../services/api";

type AuthMode = "sign-in" | "create-account";
type SendState = "idle" | "sending" | "sent" | "error";

export const AuthGate: React.FC = () => {
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [email, setEmail] = useState("");
  const [state, setState] = useState<SendState>("idle");
  const [error, setError] = useState<string | null>(null);

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
    <main className="min-h-screen bg-[#f8fafc] flex items-center justify-center px-4 py-8 font-sans text-slate-900">
      <div className="w-full max-w-[440px]">
        <div className="text-center mb-5">
          <img src="/brand/roughbid-icon.png" alt="RoughBid" className="w-16 h-16 mx-auto object-contain bg-white rounded-xl shadow-xs border border-slate-200" />
          <h1 className="text-2xl font-extrabold tracking-tight mt-3">RoughBid</h1>
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500 mt-1">
            Construction estimating & takeoff platform
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl shadow-xs p-4 sm:p-5">
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
                We sent a secure RoughBid link to <strong>{email}</strong>. Open it on this device to {mode === "create-account" ? "finish creating your account" : "enter your workspace"}.
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
      </div>
    </main>
  );
};
