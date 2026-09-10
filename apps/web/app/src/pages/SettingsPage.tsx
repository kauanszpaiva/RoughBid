import { OwnerUsagePanel } from '../components/OwnerUsagePanel';
import React, { useEffect, useState } from "react";
import { Save, Percent, User, Shield, Check, BrainCircuit, Loader2 } from "lucide-react";
import { UserProfile } from "../types";
import { grantWorkspaceAiConsent, listWorkspaces, type Workspace } from "../services/api";
import { ownerProfileImage } from "../utils/branding";

interface SettingsPageProps {
  user: UserProfile;
  onUpdateUser: (updated: UserProfile) => void;
}

const selectedWorkspaceKey = (userId: string) => `roughbid_selected_workspace_v1:${encodeURIComponent(userId)}`;

export const SettingsPage: React.FC<SettingsPageProps> = ({ user, onUpdateUser }) => {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [company, setCompany] = useState(user.company);
  const [license, setLicense] = useState(user.licenseNumber);
  const [defaultOverhead, setDefaultOverhead] = useState(user.defaultOverhead);
  const [defaultMarkup, setDefaultMarkup] = useState(user.defaultMarkup);
  const [saved, setSaved] = useState(false);
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null);
  const [aiConsentLoading, setAiConsentLoading] = useState(true);
  const [aiConsentSaving, setAiConsentSaving] = useState(false);
  const [aiConsentError, setAiConsentError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setAiConsentLoading(true);
    setAiConsentError(null);
    listWorkspaces()
      .then((workspaces) => {
        if (!active) return;
        let selectedWorkspaceId: string | null = null;
        try { selectedWorkspaceId = localStorage.getItem(selectedWorkspaceKey(user.id)); }
        catch { /* The server list remains authoritative if browser storage is unavailable. */ }
        const selected = workspaces.find((workspace) => workspace.id === selectedWorkspaceId)
          ?? workspaces.find((workspace) => workspace.createdBy === user.id && workspace.role === "admin")
          ?? workspaces[0]
          ?? null;
        setCurrentWorkspace(selected);
      })
      .catch((error) => {
        if (!active) return;
        setAiConsentError(error instanceof Error ? error.message : "Workspace AI settings could not be loaded.");
      })
      .finally(() => { if (active) setAiConsentLoading(false); });
    return () => { active = false; };
  }, [user.id]);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onUpdateUser({
      ...user,
      name,
      email,
      company,
      ...(license !== undefined ? { licenseNumber: license } : {}),
      defaultOverhead: Number(defaultOverhead),
      defaultMarkup: Number(defaultMarkup),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const handleGrantAiConsent = async () => {
    if (!currentWorkspace || currentWorkspace.createdBy !== user.id || currentWorkspace.aiProcessingConsentedAt) return;
    setAiConsentSaving(true);
    setAiConsentError(null);
    try {
      const updated = await grantWorkspaceAiConsent(currentWorkspace.id);
      setCurrentWorkspace({ ...updated, role: currentWorkspace.role });
    } catch (error) {
      setAiConsentError(error instanceof Error ? error.message : "AI plan reading could not be enabled for this workspace.");
    } finally {
      setAiConsentSaving(false);
    }
  };

  const ownsCurrentWorkspace = currentWorkspace?.createdBy === user.id;
  const aiConsented = Boolean(currentWorkspace?.aiProcessingConsentedAt);
  const ownerAvatar = ownerProfileImage(user.email);

  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto space-y-6 select-none font-sans">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[22px] font-extrabold text-slate-900 tracking-tight">
            Settings & Estimator Profile
          </h1>
          <p className="text-[13px] text-slate-500 mt-0.5">
            Set your estimator profile and defaults for new projects. Preferences are saved on this browser.
          </p>
        </div>

        {saved && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-md text-[12px] font-semibold animate-in fade-in">
            <Check className="w-4 h-4" />
            <span>Settings applied</span>
          </div>
        )}
      </div>

      <OwnerUsagePanel userId={user.id} email={user.email} />

      <form onSubmit={handleSave} className="space-y-6">
        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-4">
          <h2 className="text-[15px] font-bold text-slate-900 flex items-center gap-2">
            {ownerAvatar
              ? <img src={ownerAvatar} alt="RoughBid owner profile" className="w-11 h-11 shrink-0 rounded-full border border-slate-200 bg-white p-1 object-contain" />
              : <User className="w-4 h-4 text-blue-600" />}
            <span>Estimator & Company Information</span>
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-[13px]">
            <div>
              <label className="block text-[12px] font-medium text-slate-700 mb-1">
                Estimator Full Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-[13px]"
                required
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-slate-700 mb-1">
                Email Address
              </label>
              <input
                type="email"
                value={email}
                readOnly
                aria-label="Signed-in email address"
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-[13px]"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-[13px]">
            <div>
              <label className="block text-[12px] font-medium text-slate-700 mb-1">
                Company Name
              </label>
              <input
                type="text"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-[13px]"
                required
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-slate-700 mb-1">
                Contractor License #
              </label>
              <input
                type="text"
                value={license}
                onChange={(e) => setLicense(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-[13px]"
              />
            </div>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-4">
          <h2 className="text-[15px] font-bold text-slate-900 flex items-center gap-2">
            <Percent className="w-4 h-4 text-blue-600" />
            <span>Default Financial Engine Rates</span>
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-[13px]">
            <div>
              <label className="block text-[12px] font-medium text-slate-700 mb-1">
                Default Overhead Rate (%)
              </label>
              <input
                type="number"
                min="0"
                max="100"
                step="0.5"
                value={defaultOverhead}
                onChange={(e) => setDefaultOverhead(Number(e.target.value))}
                className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono font-bold"
              />
              <span className="text-[11px] text-slate-400 mt-1 block">
                Applied to direct material, labor & equipment costs.
              </span>
            </div>
            <div>
              <label className="block text-[12px] font-medium text-slate-700 mb-1">
                Default Markup Rate (%)
              </label>
              <input
                type="number"
                min="0"
                max="100"
                step="0.5"
                value={defaultMarkup}
                onChange={(e) => setDefaultMarkup(Number(e.target.value))}
                className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono font-bold"
              />
              <span className="text-[11px] text-slate-400 mt-1 block">
                Applied to Cost Before Markup to derive client price and margin.
              </span>
            </div>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 shrink-0 rounded-lg bg-violet-50 text-violet-700 flex items-center justify-center">
              <BrainCircuit className="w-5 h-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-[14px] font-bold text-slate-900">AI plan reading</h3>
                  <p className="text-[12px] text-slate-500 mt-0.5">
                    {currentWorkspace ? `Workspace: ${currentWorkspace.name}` : "Current workspace"}
                  </p>
                </div>
                {aiConsented && (
                  <span className="px-3 py-1 rounded bg-emerald-50 text-emerald-700 text-[12px] font-bold border border-emerald-200">
                    Enabled
                  </span>
                )}
              </div>

              <p className="text-[12px] text-slate-600 mt-3 leading-5">
                By enabling AI plan reading, plan files in this workspace may be sent to the configured AI provider for analysis. AI output still requires human review before it becomes estimate data.
              </p>

              {aiConsentLoading ? (
                <div className="mt-3 flex items-center gap-2 text-[12px] text-slate-500">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading workspace AI settings…
                </div>
              ) : aiConsented ? (
                <p className="mt-3 text-[12px] text-emerald-700 font-medium">
                  AI plan reading was enabled {currentWorkspace?.aiProcessingConsentedAt ? new Date(currentWorkspace.aiProcessingConsentedAt).toLocaleString() : "for this workspace"}.
                </p>
              ) : ownsCurrentWorkspace ? (
                <button
                  type="button"
                  disabled={aiConsentSaving}
                  onClick={handleGrantAiConsent}
                  className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-md bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-[12.5px] font-semibold transition"
                >
                  {aiConsentSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                  Enable AI plan reading
                </button>
              ) : (
                <p className="mt-3 text-[12px] text-amber-700 font-medium">
                  Only the workspace owner can enable AI plan reading for this workspace.
                </p>
              )}

              {aiConsentError && <p role="alert" className="mt-3 text-[12px] text-red-700">{aiConsentError}</p>}
            </div>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-[14px] font-bold text-slate-900">
                RoughBid SaaS Account
              </h3>
              <p className="text-[12px] text-slate-500">
                Independent estimating workspace
              </p>
            </div>
          </div>

          <span className="px-3 py-1 rounded bg-emerald-50 text-emerald-700 text-[12px] font-bold border border-emerald-200">
            Active
          </span>
        </div>

        <div className="flex justify-end pt-2">
          <button
            type="submit"
            className="flex items-center gap-1.5 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-[13.5px] font-semibold transition shadow-xs cursor-pointer"
          >
            <Save className="w-4 h-4" />
            <span>Save Preferences</span>
          </button>
        </div>
      </form>
    </div>
  );
};
