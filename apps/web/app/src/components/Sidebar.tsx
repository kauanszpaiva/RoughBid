import React from "react";
import {
  LayoutDashboard,
  FolderOpen,
  Compass,
  Layers,
  Boxes,
  Receipt,
  Settings,
  HelpCircle,
  Sparkles,
  X,
} from "lucide-react";
import { UserProfile } from "../types";

export type NavTab =
  | "dashboard"
  | "projects"
  | "templates"
  | "materials"
  | "assemblies"
  | "pricelists"
  | "settings"
  | "help";

interface SidebarProps {
  currentTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  user: UserProfile;
  onOpenAuth: () => void;
  isMobileOpen?: boolean;
  onCloseMobile?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onSelectTab,
  user,
  onOpenAuth,
  isMobileOpen = false,
  onCloseMobile,
}) => {
  const mainNavItems: { id: NavTab; label: string; icon: React.ReactNode }[] = [
    {
      id: "dashboard",
      label: "Dashboard",
      icon: <LayoutDashboard className="w-4 h-4" />,
    },
    {
      id: "projects",
      label: "Projects",
      icon: <FolderOpen className="w-4 h-4" />,
    },
    {
      id: "templates",
      label: "Templates",
      icon: <Compass className="w-4 h-4" />,
    },
    {
      id: "materials",
      label: "Materials",
      icon: <Layers className="w-4 h-4" />,
    },
    {
      id: "assemblies",
      label: "Assemblies",
      icon: <Boxes className="w-4 h-4" />,
    },
    {
      id: "pricelists",
      label: "Price Lists",
      icon: <Receipt className="w-4 h-4" />,
    },
  ];

  const handleItemClick = (tab: NavTab) => {
    onSelectTab(tab);
    if (onCloseMobile) {
      onCloseMobile();
    }
  };

  const renderNavContent = (isDrawer = false) => (
    <>
      {/* Top Logo Section */}
      <div>
        <div
          className="p-6 border-b border-[#e5e7eb] flex items-center justify-between cursor-pointer"
          onClick={() => handleItemClick("projects")}
        >
          <div>
            <div className="flex items-center gap-2.5">
              <img
                src="/roughbid-logo-generated.png"
                alt="RoughBid"
                className="w-40 h-12 object-contain object-left rounded bg-white"
              />
            </div>
            <p className="text-[10px] text-[#6b7280] mt-1 uppercase font-semibold tracking-widest pl-0.5">
              by KSP Ventures
            </p>
          </div>

          {isDrawer && onCloseMobile && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCloseMobile();
              }}
              className="p-2 text-[#9ca3af] hover:text-[#111827] rounded-md transition"
              aria-label="Close menu"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Navigation List */}
        <nav className="p-4 space-y-1">
          <div className="px-3 pb-2 pt-1 text-[10px] font-bold text-[#9ca3af] uppercase tracking-wider">
            Main Navigation
          </div>
          {mainNavItems.map((item) => {
            const isActive = currentTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => handleItemClick(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-colors text-left cursor-pointer ${
                  isActive
                    ? "text-[#2563eb] bg-[#eff6ff] font-semibold"
                    : "text-[#6b7280] hover:bg-[#f3f4f6] hover:text-[#111827]"
                }`}
              >
                <span className={isActive ? "text-[#2563eb]" : "text-[#6b7280]"}>
                  {item.icon}
                </span>
                <span>{item.label}</span>
              </button>
            );
          })}

          <div className="pt-4 pb-2 px-3 text-[10px] font-bold text-[#9ca3af] uppercase tracking-wider">
            System & Support
          </div>
          <button
            onClick={() => handleItemClick("settings")}
            className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-colors text-left cursor-pointer ${
              currentTab === "settings"
                ? "text-[#2563eb] bg-[#eff6ff] font-semibold"
                : "text-[#6b7280] hover:bg-[#f3f4f6] hover:text-[#111827]"
            }`}
          >
            <Settings className="w-4 h-4 text-[#6b7280]" />
            <span>Settings</span>
          </button>

          <button
            onClick={() => handleItemClick("help")}
            className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-colors text-left cursor-pointer ${
              currentTab === "help"
                ? "text-[#2563eb] bg-[#eff6ff] font-semibold"
                : "text-[#6b7280] hover:bg-[#f3f4f6] hover:text-[#111827]"
            }`}
          >
            <HelpCircle className="w-4 h-4 text-[#6b7280]" />
            <span>Help & Docs</span>
          </button>
        </nav>
      </div>

      {/* Bottom User / Pass Profile */}
      <div className="p-4 border-t border-[#e5e7eb]">
        <div
          onClick={() => {
            onOpenAuth();
            if (onCloseMobile) onCloseMobile();
          }}
          className="bg-[#f3f4f6] hover:bg-[#e5e7eb]/80 p-3 rounded-lg flex items-center gap-3 cursor-pointer transition"
        >
          <div className="w-8 h-8 rounded-full bg-[#d1d5db] text-[#374151] font-bold text-xs flex items-center justify-center shrink-0">
            {user.name
              .split(" ")
              .map((n) => n[0])
              .join("") || "JA"}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-[#111827] truncate">{user.name}</p>
            <p className="text-[10px] text-[#6b7280] truncate flex items-center gap-1">
              <Sparkles className="w-2.5 h-2.5 text-[#2563eb]" />
              <span>{user.plan}</span>
            </p>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* Desktop Sidebar (hidden on mobile) */}
      <aside className="hidden md:flex w-64 bg-white border-r border-[#e5e7eb] flex-col justify-between h-screen select-none shrink-0 font-sans">
        {renderNavContent(false)}
      </aside>

      {/* Mobile Drawer (visible when isMobileOpen is true) */}
      {isMobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden select-none">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-2xs transition-opacity"
            onClick={onCloseMobile}
          />

          {/* Slide-out Drawer Panel */}
          <aside className="fixed inset-y-0 left-0 w-72 max-w-[85vw] bg-white border-r border-[#e5e7eb] flex flex-col justify-between h-full shadow-2xl z-10 font-sans overflow-y-auto">
            {renderNavContent(true)}
          </aside>
        </div>
      )}
    </>
  );
};
