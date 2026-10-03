import React, { useEffect, useRef, useState } from "react";
import { X, Mail, LogOut, ShieldCheck, Link as LinkIcon, Copy, UserPlus } from "lucide-react";
import { supabase, isAuthConfigured, type Session } from "../services/supabaseClient";
import { createWorkspaceInvite, requestMagicLink, type Workspace } from "../services/api";
import { ownerProfileImage } from "../utils/branding";
import { normalizeAuthEmail, signOutLocally } from "../services/authForm";
import { useDialogFocus } from "../services/useDialogFocus";

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
  const [inviteLinkScope, setInviteLinkScope] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const requestEpoch = useRef(0);
  const pendingSignIn = useRef(false);
  const pendingInvite = useRef(false);
  const pendingSignOut = useRef(false);
  const accountScope = `${session?.user.id ?? 'signed-out'}:${workspace?.id ?? 'no-workspace'}`;
  const visibleInviteLink = inviteLinkScope === accountScope ? inviteLink : null;
  useDialogFocus(isOpen, dialogRef, onClose);
  useEffect(() => {
    requestEpoch.current++;
    setEmail(""); setState("idle"); setError(null);
    setInviteEmail(""); setInviteRole("estimator"); setInviteState("idle");
    setInviteLink(null); setInviteLinkScope(null); setInviteError(null); setInviteEmailSent(false);
    setSigningOut(false); setSignOutError(null);
    pendingSignIn.current = false; pendingInvite.current = false; pendingSignOut.current = false;
    return () => { requestEpoch.current++; };
  }, [isOpen, accountScope]);

  if (!isOpen) return null;

  const handleSendLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pendingSignIn.current) return;
    if (!isAuthConfigured) {
      setState("error");
      setError("Sign-in is not configured for this environment.");
      return;
    }
    let normalizedEmail: string;
    try { normalizedEmail = normalizeAuthEmail(email); }
    catch (error) { setState("error"); setError(error instanceof Error ? error.message : "Enter a valid email address."); return; }
    const epoch = requestEpoch.current;
    pendingSignIn.current = true;
    setState("sending");
    setError(null);
    const inviteToken = new URLSearchParams(window.location.search).get("invite");
    const pilotInviteToken = new URLSearchParams(window.location.search).get("pilot_invite");
    try {
      await requestMagicLink({ email: normalizedEmail, inviteToken, pilotInviteToken });
      if (epoch !== requestEpoch.current) return;
      setEmail(normalizedEmail);
      setState("sent");
    } catch (error) {
      if (epoch !== requestEpoch.current) return;
      setState("error");
      setError(error instanceof Error ? error.message : "We could not send your sign-in link.");
    } finally { if (epoch === requestEpoch.current) pendingSignIn.current = false; }
  };

  const handleSignOut = async () => {
    if (pendingSignOut.current) return;
    const epoch = requestEpoch.current;
    pendingSignOut.current = true; setSigningOut(true); setSignOutError(null);
    try {
      await signOutLocally(supabase?.auth ?? null);
      if (epoch === requestEpoch.current) onClose();
    } catch (error) {
      if (epoch === requestEpoch.current) setSignOutError(error instanceof Error ? error.message : "We could not sign you out. Try again.");
    } finally {
      if (epoch === requestEpoch.current) { pendingSignOut.current = false; setSigningOut(false); }
    }
  };

  const handleCreateInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspace || workspace.role !== "admin" || pendingInvite.current) return;
    let normalizedEmail: string;
    try { normalizedEmail = normalizeAuthEmail(inviteEmail); }
    catch (error) { setInviteState("error"); setInviteError(error instanceof Error ? error.message : "Enter a valid email address."); return; }
    const epoch = requestEpoch.current;
    pendingInvite.current = true;
    setInviteState("creating");
    setInviteError(null);
    setInviteEmailSent(false);
    setInviteLink(null);
    try {
      const invite = await createWorkspaceInvite(workspace.id, { email: normalizedEmail, role: inviteRole });
      if (epoch !== requestEpoch.current) return;
      setInviteLink(`${window.location.origin}/app/?invite=${encodeURIComponent(invite.token)}`);
      setInviteLinkScope(accountScope);
      setInviteState("ready");
      setInviteEmailSent(invite.emailSent === true);
      if (invite.emailError) {
        setInviteError("Invite link created, but the email was not sent. Copy the backup link below.");
      }
    } catch (error) {
      if (epoch !== requestEpoch.current) return;
      setInviteState("error");
      setInviteError(error instanceof Error ? error.message : "Could not create invite.");
    } finally { if (epoch === requestEpoch.current) pendingInvite.current = false; }
  };

  const handleCopyInvite = async () => {
    if (!visibleInviteLink) return;
    try {
      await navigator.clipboard.writeText(visibleInviteLink);
    } catch {
      setInviteError("Copy failed. Select the link and copy it manually.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-2xs p-2 sm:p-4 animate-in fade-in duration-150">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="account-dialog-title" tabIndex={-1} className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-md max-h-[calc(100dvh-1rem)] overflow-y-auto">
        <div className="px-4 py-3 sm:px-6 sm:py-4 bg-white border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <img src="/brand/roughbid-mark.png" alt="RoughBid" className="w-8 h-8 object-contain" />
            <div>
              <h3 id="account-dialog-title" className="text-sm font-bold text-slate-900">{session ? "Account and workspace" : "Sign in"}</h3>
              <p className="text-xs text-slate-500">{session ? "Manage access on this device." : "RoughBid emails a secure access link."}</p>
            </div>
          </div>
          <button type="button" aria-label="Close account dialog" onClick={onClose} className="text-slate-400 hover:text-slate-900 rounded-md transition p-1 focus-visible:outline-2 focus-visible:outline-offset-2">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-6 space-y-4 text-slate-900 text-xs">
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
              <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg border border-slate-200">
                <div className="w-12 h-12 rounded-full bg-brand-50 text-brand-500 font-bold text-sm flex items-center justify-center border border-blue-200 shrink-0">
                  {ownerProfileImage(session.user.email)
                    ? <img src="/brand/roughbid-mark.png" alt="RoughBid owner profile" className="w-full h-full rounded-full bg-white p-1 object-contain" />
                    : <ShieldCheck className="w-5 h-5" />}
                </div>
                <div>
                  <div className="text-sm font-bold text-slate-900">{session.user.email}</div>
                  <div className="text-xs text-slate-500">
                    {workspace ? `Workspace: ${workspace.name}` : "Setting up your workspace..."}
                  </div>
                </div>
              </div>
              {inviteNotice && (
                <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-800 text-xs">
                  {inviteNotice}
                </div>
              )}
              {workspace?.role === "admin" ? <form onSubmit={handleCreateInvite} aria-busy={inviteState === "creating"} className="p-3.5 bg-white border border-slate-200 rounded-lg space-y-3">
                <div>
                  <div className="font-bold text-slate-900 flex items-center gap-1.5">
                    <LinkIcon className="w-3.5 h-3.5 text-brand-500" />
                    Invite a teammate
                  </div>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Generate a secure organization invite link. The link expires in 14 days.
                  </p>
                </div>
                <label className="block">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Teammate email</span>
                  <input
                    type="email"
                    name="invite-email"
                    autoComplete="email"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={254}
                    disabled={inviteState === "creating"}
                    required
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="teammate@company.com"
                    className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Role</span>
                  <select
                    value={inviteRole}
                    disabled={inviteState === "creating"}
                    onChange={(e) => setInviteRole(e.target.value as "estimator" | "viewer")}
                    className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-md text-sm bg-white"
                  >
                    <option value="estimator">Estimator - can edit projects</option>
                    <option value="viewer">Viewer - read only</option>
                  </select>
                </label>
                {inviteError && (
                  <p role="alert" className={`${inviteState === "error" ? "text-red-600" : "text-amber-700"} text-xs`}>
                    {inviteError}
                  </p>
                )}
                {inviteEmailSent && <p role="status" className="text-emerald-700 text-xs">Invitation emailed. The link below is a backup.</p>}
                {visibleInviteLink && (
                  <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-md">
                    <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Invite link</p>
                    <div className="flex gap-2">
                      <input aria-label="Private workspace invite link" readOnly value={visibleInviteLink} onFocus={(event) => event.currentTarget.select()} className="flex-1 min-w-0 px-2 py-1.5 bg-white border border-slate-200 rounded text-[11px] text-slate-600" />
                      <button type="button" onClick={handleCopyInvite} className="px-2.5 py-1.5 bg-slate-900 text-white rounded text-xs font-semibold flex items-center gap-1">
                        <Copy className="w-3.5 h-3.5" />
                        Copy
                      </button>
                    </div>
                  </div>
                )}
                <button
                  type="submit"
                  disabled={!workspace || workspace.role !== "admin" || inviteState === "creating"}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-700 disabled:opacity-60 text-white text-xs font-semibold rounded-md transition"
                >
                  <Mail className="w-3.5 h-3.5" />
                  {inviteState === "creating" ? "Creating invite..." : "Create invite link"}
                </button>
              </form> : workspace && <p className="text-xs text-slate-500">Your role is {workspace.role ?? "unavailable"}. Ask a workspace admin to invite teammates.</p>}
              {signOutError && <p role="alert" className="text-xs text-red-600">{signOutError}</p>}
              <button
                type="button"
                onClick={handleSignOut}
                disabled={signingOut}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-900 text-xs font-semibold rounded-md transition"
              >
                <LogOut className="w-3.5 h-3.5" />
                {signingOut ? "Signing out..." : "Sign out on this device"}
              </button>
            </>
          )}

          {isAuthConfigured && !session && state !== "sent" && (
            <form onSubmit={handleSendLink} aria-busy={state === "sending"} className="space-y-3">
              <div className="p-3.5 bg-brand-50 border border-blue-200 rounded-lg text-brand-900 flex gap-2.5">
                <UserPlus className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold">Sign in to your RoughBid account.</div>
                  <p className="text-brand-400 mt-0.5">No password setup. New accounts require an invitation during the pilot.</p>
                </div>
              </div>
              <label className="block">
                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Email</span>
                <input
                  type="email"
                  name="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={254}
                  disabled={state === "sending"}
                  data-dialog-initial-focus
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </label>
              {state === "error" && error && (
                <p role="alert" className="text-red-600 text-xs">{error}</p>
              )}
              <button
                type="submit"
                disabled={state === "sending"}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-700 disabled:opacity-60 text-white text-xs font-semibold rounded-md transition"
              >
                <Mail className="w-3.5 h-3.5" />
                {state === "sending" ? "Sending..." : "Email me a sign-in link"}
              </button>
            </form>
          )}

          {isAuthConfigured && !session && state === "sent" && (
            <div role="status" aria-live="polite" className="p-3.5 bg-brand-50 border border-blue-200 rounded-lg text-brand-900">
              <div className="font-semibold mb-1">Check your email</div>
              <p className="text-brand-400">
                Check the inbox and spam folder for <strong>{email}</strong>. If your request can be completed, a sign-in link will arrive. Open it on this device to finish signing in.
              </p>
              <button type="button" onClick={() => { setState("idle"); setError(null); }} className="mt-3 rounded border border-blue-200 bg-white px-3 py-2 font-semibold">Use another email</button>
            </div>
          )}
        </div>

        <div className="px-4 py-3 sm:px-6 bg-slate-50 border-t border-slate-200 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-slate-900 hover:bg-black text-white text-xs font-semibold rounded-md transition"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
