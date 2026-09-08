import React, { useState } from "react";
import { X, Mail, LogOut, ShieldCheck, Link as LinkIcon, Copy, UserPlus } from "lucide-react";
import { supabase, isAuthConfigured, type Session } from "../services/supabaseClient";
import { createWorkspaceInvite, requestMagicLink, type Workspace } from "../services/api";
import { ownerProfileImage } from "../utils/branding";

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  session: Session | null;
  workspace?: Workspace | null;
  inviteNotice?: string | null;
}

type SendState = "idle" | "sending" | "sent" | "error";
type InviteState = "idle" | "creating" | "ready" | "error";

export const AuthModal: React.FC<AuthModalProps> = ({ isOpen, onClose, session, workspace, inviteNotice }) => {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<SendState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"estimator" | "viewer">("estimator");
  const [inviteState, setInviteState] = useState<InviteState>("idle");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteEmailSent, setInviteEmailSent] = useState(false);

  if (!isOpen) return null;

  const handleSendLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAuthConfigured) {
      setState("error");
      setError("Sign-in is not configured for this environment.");
      return;
    }
    setState("sending");
    setError(null);
    const inviteToken = new URLSearchParams(window.location.search).get("invite");
    const pilotInviteToken = new URLSearchParams(window.location.search).get("pilot_invite");
    try {
      await requestMagicLink({ email: email.trim(), inviteToken, pilotInviteToken });
    } catch (error) {
      setState("error");
      setError(error instanceof Error ? error.message : "We could not send your sign-in link.");
      return;
    }
    setState("sent");
  };

  const handleSignOut = async () => {
    await supabase?.auth.signOut();
    onClose();
  };

  const handleCreateInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspace || workspace.role !== "admin") return;
    setInviteState("creating");
    setInviteError(null);
    setInviteEmailSent(false);
    setInviteLink(null);
    try {
      const invite = await createWorkspaceInvite(workspace.id, { email: inviteEmail, role: inviteRole });
      setInviteLink(`${window.location.origin}/app/?invite=${encodeURIComponent(invite.token)}`);
      setInviteState("ready");
      setInviteEmailSent(invite.emailSent === true);
      if (invite.emailError) {
        setInviteError("Invite link created, but the email was not sent. Copy the backup link below.");
      }
    } catch (error) {
      setInviteState("error");
      setInviteError(error instanceof Error ? error.message : "Could not create invite.");
    }
  };

  const handleCopyInvite = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
    } catch {
      setInviteError("Copy failed. Select the link and copy it manually.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-2xs p-2 sm:p-4 select-none animate-in fade-in duration-150">
      <div className="bg-white rounded-xl shadow-xl border border-[#e5e7eb] w-full max-w-md overflow-hidden">
        <div className="px-4 py-3 sm:px-6 sm:py-4 bg-white border-b border-[#e5e7eb] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <img src="/brand/roughbid-mark.png" alt="RoughBid" className="w-8 h-8 object-contain" />
            <div>
              <h3 className="text-sm font-bold text-[#111827]">Sign in / Create account</h3>
              <p className="text-xs text-[#6b7280]">Enter your email. RoughBid sends a secure access link.</p>
            </div>
          </div>
          <button onClick={onClose} className="text-[#9ca3af] hover:text-[#111827] rounded-md transition p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-6 space-y-4 text-[#111827] text-xs">
          {!isAuthConfigured && (
            <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-amber-900">
              <div className="font-semibold mb-1">App access locked</div>
              <p className="text-amber-800">
                Sign-in is not configured in this environment. RoughBid requires Supabase Auth before workspace access.
              </p>
            </div>
          )}

          {isAuthConfigured && session && (
            <>
              <div className="flex items-center gap-3 p-3 bg-[#f9fafb] rounded-lg border border-[#e5e7eb]">
                <div className="w-12 h-12 rounded-full bg-[#eff6ff] text-[#2563eb] font-bold text-sm flex items-center justify-center border border-blue-200 shrink-0">
                  {ownerProfileImage(session.user.email)
                    ? <img src="/brand/roughbid-mark.png" alt="RoughBid owner profile" className="w-full h-full rounded-full bg-white p-1 object-contain" />
                    : <ShieldCheck className="w-5 h-5" />}
                </div>
                <div>
                  <div className="text-sm font-bold text-[#111827]">{session.user.email}</div>
                  <div className="text-xs text-[#6b7280]">
                    {workspace ? `Workspace: ${workspace.name}` : "Setting up your workspace..."}
                  </div>
                </div>
              </div>
              {inviteNotice && (
                <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-800 text-xs">
                  {inviteNotice}
                </div>
              )}
              <form onSubmit={handleCreateInvite} className="p-3.5 bg-white border border-[#e5e7eb] rounded-lg space-y-3">
                <div>
                  <div className="font-bold text-[#111827] flex items-center gap-1.5">
                    <LinkIcon className="w-3.5 h-3.5 text-[#2563eb]" />
                    Invite a teammate
                  </div>
                  <p className="text-[11px] text-[#6b7280] mt-0.5">
                    Generate a secure organization invite link. The link expires in 14 days.
                  </p>
                </div>
                <label className="block">
                  <span className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider">Teammate email</span>
                  <input
                    type="email"
                    required
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="teammate@company.com"
                    className="mt-1 w-full px-3 py-2 border border-[#e5e7eb] rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[#2563eb]"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider">Role</span>
                  <select
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value as "estimator" | "viewer")}
                    className="mt-1 w-full px-3 py-2 border border-[#e5e7eb] rounded-md text-sm bg-white"
                  >
                    <option value="estimator">Estimator - can edit projects</option>
                    <option value="viewer">Viewer - read only</option>
                  </select>
                </label>
                {inviteError && (
                  <p className={`${inviteState === "error" ? "text-red-600" : "text-amber-700"} text-xs`}>
                    {inviteError}
                  </p>
                )}
                {inviteEmailSent && <p className="text-emerald-700 text-xs">Invite email sent through Resend. The link is still shown below as backup.</p>}
                {inviteLink && (
                  <div className="p-2.5 bg-[#f9fafb] border border-[#e5e7eb] rounded-md">
                    <p className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider mb-1">Invite link</p>
                    <div className="flex gap-2">
                      <input readOnly value={inviteLink} className="flex-1 min-w-0 px-2 py-1.5 bg-white border border-[#e5e7eb] rounded text-[11px] text-[#374151]" />
                      <button type="button" onClick={handleCopyInvite} className="px-2.5 py-1.5 bg-[#111827] text-white rounded text-xs font-semibold flex items-center gap-1">
                        <Copy className="w-3.5 h-3.5" />
                        Copy
                      </button>
                    </div>
                  </div>
                )}
                <button
                  type="submit"
                  disabled={!workspace || workspace.role !== "admin" || inviteState === "creating"}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-[#2563eb] hover:bg-[#1d4ed8] disabled:opacity-60 text-white text-xs font-semibold rounded-md transition"
                >
                  <Mail className="w-3.5 h-3.5" />
                  {inviteState === "creating" ? "Creating invite..." : "Create invite link"}
                </button>
              </form>
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
              <div className="p-3.5 bg-[#eff6ff] border border-blue-200 rounded-lg text-[#1e3a8a] flex gap-2.5">
                <UserPlus className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold">One email creates or opens your RoughBid account.</div>
                  <p className="text-[#3b82f6] mt-0.5">No password setup. Organization invites are accepted after the same login link.</p>
                </div>
              </div>
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
                {state === "sending" ? "Sending..." : "Email me a sign-in link"}
              </button>
            </form>
          )}

          {isAuthConfigured && !session && state === "sent" && (
            <div className="p-3.5 bg-[#eff6ff] border border-blue-200 rounded-lg text-[#1e3a8a]">
              <div className="font-semibold mb-1">Check your email</div>
              <p className="text-[#3b82f6]">
                Check the inbox and spam folder for <strong>{email}</strong>. If your request can be completed, a sign-in link will arrive. Open it on this device to finish signing in.
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
