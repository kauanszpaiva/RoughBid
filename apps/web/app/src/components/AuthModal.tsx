import React from "react";
import { X, Sparkles } from "lucide-react";
import { UserProfile } from "../types";

interface AuthModalProps {
  user: UserProfile;
  isOpen: boolean;
  onClose: () => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({ user, isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-2xs p-2 sm:p-4 select-none animate-in fade-in duration-150">
      <div className="bg-white rounded-xl shadow-xl border border-[#e5e7eb] w-full max-w-md overflow-hidden">
        <div className="px-4 py-3 sm:px-6 sm:py-4 bg-white border-b border-[#e5e7eb] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#2563eb] flex items-center justify-center text-white font-bold text-xs">
              R
            </div>
            <div>
              <h3 className="text-sm font-bold text-[#111827]">Estimator Account</h3>
              <p className="text-xs text-[#6b7280]">Prime Bid Class Pass Member</p>
            </div>
          </div>
          <button onClick={onClose} className="text-[#9ca3af] hover:text-[#111827] rounded-md transition p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-6 space-y-4 text-[#111827] text-xs">
          <div className="flex items-center gap-3 p-3 bg-[#f9fafb] rounded-lg border border-[#e5e7eb]">
            <div className="w-12 h-12 rounded-full bg-[#eff6ff] text-[#2563eb] font-bold text-sm flex items-center justify-center border border-blue-200 shrink-0">
              {user.name.split(" ").map((n) => n[0]).join("") || "JS"}
            </div>
            <div>
              <div className="text-sm font-bold text-[#111827]">{user.name}</div>
              <div className="text-xs text-[#6b7280]">{user.email}</div>
              <div className="text-xs text-[#2563eb] font-semibold">{user.company}</div>
            </div>
          </div>

          <div className="p-4 bg-[#eff6ff] border border-blue-200 rounded-lg space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[#1e40af] flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-[#2563eb]" />
                <span>Prime Bid Class Pass</span>
              </span>
              <span className="text-[10px] bg-[#2563eb] text-white font-bold px-2 py-0.5 rounded">
                Active
              </span>
            </div>
            <p className="text-xs text-[#3b82f6]">
              Access Granted: Unlimited plan uploads, full deterministic financial engine, instant PDF export, and Prime Bid cloud synchronization.
            </p>
            <div className="text-xs font-semibold text-[#1e3a8a] pt-1">
              ⏳ {user.classPassRemainingDays} days remaining in current period
            </div>
          </div>
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
