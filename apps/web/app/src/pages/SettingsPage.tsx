import React, { useState } from "react";
import { Settings, Save, Building, Percent, User, Shield, Check } from "lucide-react";
import { UserProfile } from "../types";

interface SettingsPageProps {
  user: UserProfile;
  onUpdateUser: (updated: UserProfile) => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({ user, onUpdateUser }) => {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [company, setCompany] = useState(user.company);
  const [license, setLicense] = useState(user.licenseNumber);
  const [defaultOverhead, setDefaultOverhead] = useState(user.defaultOverhead);
  const [defaultMarkup, setDefaultMarkup] = useState(user.defaultMarkup);
  const [saved, setSaved] = useState(false);

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

      <form onSubmit={handleSave} className="space-y-6">
        {/* Estimator Profile Card */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-4">
          <h2 className="text-[15px] font-bold text-slate-900 flex items-center gap-2">
            <User className="w-4 h-4 text-blue-600" />
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

        {/* Default Financial Rates */}
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

        {/* RoughBid account status */}
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
