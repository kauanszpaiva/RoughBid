import React, { useState } from "react";
import { X, Mail, LogOut, ShieldCheck } from "lucide-react";
import { supabase, isAuthConfigured, type Session } from "../services/supabaseClient";

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  session: Session | null;
  workspaceName?: string | null;
}

type SendState = "idle" | "sending" | "sent" | "error";

export const AuthModal: React.FC<AuthModalProps> = ({ isOpen, onClose, session, workspaceName }) => {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<SendState>("idle");
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSendLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    setState("sending");
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/app/` },
    });
    if (signInError) {
      setState("error");
      setError(signInError.message);
      return;
    }
    setState("sent");
  };

  const handleSignOut = async () => {
    await supabase?.auth.signOut();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-2xs p-2 sm:p-4 select-none animate-in fade-in duration-150">
      <div className="bg-white rounded-xl shadow-xl border border-[#e5e7eb] w-full max-w-md overflow-hidden">
        <div className="px-4 py-3 sm:px-6 sm:py-4 bg-white border-b border-[#e5e7eb] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#2563eb] flex items-center justify-center text-white font-bold text-xs">
              R
            </div>
            <div>
              <h3 className="text-sm font-bold text-[#111827]">Account</h3>
              <p className="text-xs text-[#6b7280]">Sign in with a magic link — no password.</p>
            </div>
          </div>
          <button onClick={onClose} className="text-[#9ca3af] hover:text-[#111827] rounded-md transition p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-6 space-y-4 text-[#111827] text-xs">
          {!isAuthConfigured && (
            <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-amber-900">
              <div className="font-semibold mb-1">Demo mode</div>
              <p className="text-amber-800">
                Sign-in isn't configured in this environment yet. You're browsing with local demo data —
                nothing you do here reaches a server.
              </p>
            </div>
          )}

          {isAuthConfigured && session && (
            <>
              <div className="flex items-center gap-3 p-3 bg-[#f9fafb] rounded-lg border border-[#e5e7eb]">
                <div className="w-12 h-12 rounded-full bg-[#eff6ff] text-[#2563eb] font-bold text-sm flex items-center justify-center border border-blue-200 shrink-0">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-sm font-bold text-[#111827]">{session.user.email}</div>
                  <div className="text-xs text-[#6b7280]">
                    {workspaceName ? `Workspace: ${workspaceName}` : "Setting up your workspace…"}
                  </div>
                </div>
              </div>
              <button
                onClick={handleSignOut}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-[#f3f4f6] hover:bg-[#e5e7eb] text-[#111827] text-xs font-semibold rounded-md transition"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sign out
              </button>
            </>
          )}

          {isAuthConfigured && !session && state !== "sent" && (
            <form onSubmit={handleSendLink} className="space-y-3">
              <label className="block">
                <span className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider">Email</span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="mt-1 w-full px-3 py-2 border border-[#e5e7eb] rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[#2563eb]"
                />
              </label>
              {state === "error" && error && (
                <p className="text-red-600 text-xs">{error}</p>
              )}
              <button
                type="submit"
                disabled={state === "sending"}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-[#2563eb] hover:bg-[#1d4ed8] disabled:opacity-60 text-white text-xs font-semibold rounded-md transition"
              >
                <Mail className="w-3.5 h-3.5" />
                {state === "sending" ? "Sending…" : "Send magic link"}
              </button>
            </form>
          )}

          {isAuthConfigured && !session && state === "sent" && (
            <div className="p-3.5 bg-[#eff6ff] border border-blue-200 rounded-lg text-[#1e3a8a]">
              <div className="font-semibold mb-1">Check your email</div>
              <p className="text-[#3b82f6]">
                We sent a sign-in link to <strong>{email}</strong>. Open it on this device to finish signing in.
              </p>
            </div>
          )}
        </div>

        <div className="px-4 py-3 sm:px-6 bg-[#f9fafb] border-t border-[#e5e7eb] flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-[#111827] hover:bg-black text-white text-xs font-semibold rounded-md transition"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
