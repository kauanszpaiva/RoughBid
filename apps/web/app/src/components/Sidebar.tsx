import React from "react";
import {
  LayoutDashboard,
  FolderOpen,
  Compass,
  Layers,
  Boxes,
  Receipt,
  CreditCard,
  Settings,
  HelpCircle,
  Sparkles,
  X,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { UserProfile } from "../types";
import { ownerProfileImage } from "../utils/branding";

export type NavTab =
  | "dashboard"
  | "projects"
  | "templates"
  | "materials"
  | "assemblies"
  | "pricelists"
  | "billing"
  | "access"
  | "settings"
  | "help";

interface SidebarProps {
  currentTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  user: UserProfile;
  onOpenAuth: () => void;
  isMobileOpen?: boolean;
  onCloseMobile?: () => void;
  isCollapsed?: boolean;
  onToggleCollapsed?: () => void;
  isSignedIn?: boolean;
  isPlatformOwner?: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onSelectTab,
  user,
  onOpenAuth,
  isMobileOpen = false,
  onCloseMobile,
  isCollapsed = false,
  onToggleCollapsed,
  isSignedIn = false,
  isPlatformOwner = false,
}) => {
  const ownerAvatar = ownerProfileImage(user.email);
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
    {
      id: "billing",
      label: "Billing",
      icon: <CreditCard className="w-4 h-4" />,
    },
  ];
  if (isPlatformOwner) mainNavItems.push({ id: 'access', label: 'Access invitations', icon: <LayoutDashboard className="w-4 h-4" /> });

  const handleItemClick = (tab: NavTab) => {
    onSelectTab(tab);
    if (onCloseMobile) {
      onCloseMobile();
    }
  };

  const renderNavContent = (isDrawer = false) => {
    const collapsed = !isDrawer && isCollapsed;
    return (
    <>
      {/* Top Logo Section */}
      <div>
        <div
          className={`${collapsed ? "p-3 justify-center" : "px-5 py-6"} border-b border-white/10 flex items-center justify-between cursor-pointer`}
          onClick={() => handleItemClick("projects")}
        >
          <div className={`${collapsed ? "w-full flex justify-center" : ""}`}>
            <img
              src={collapsed ? "/brand/roughbid-mark.png" : "/brand/roughbid-logo.png"}
              alt="RoughBid"
              className={`${collapsed ? "w-9 h-9" : "w-44 h-11"} object-contain object-left`}
            />
            {!collapsed && (
              <p className="sr-only">
                RoughBid
              </p>
            )}
          </div>

          {isDrawer && onCloseMobile && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCloseMobile();
              }}
              className="min-w-11 min-h-11 text-white/55 hover:text-white hover:bg-white/[.06] transition inline-flex items-center justify-center"
              aria-label="Close menu"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Navigation List */}
        <nav className={`${collapsed ? "p-2" : "px-3 py-6"} space-y-1`}>
          {!collapsed && <div className="px-3 pb-3 pt-1 font-mono text-[9px] font-semibold text-white/35 uppercase tracking-[.2em]">
            [01 / Workspace]
          </div>}
          {mainNavItems.map((item) => {
            const isActive = currentTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => handleItemClick(item.id)}
                title={collapsed ? item.label : undefined}
                className={`w-full flex items-center ${collapsed ? "justify-center px-2" : "gap-3 px-3"} min-h-11 py-2.5 text-sm font-medium transition-all text-left cursor-pointer border-l-2 ${
                  isActive
                    ? "border-[#d9ff43] text-[#d9ff43] bg-white/[.06] font-semibold"
                    : "border-transparent text-white/55 hover:border-white/30 hover:bg-white/[.04] hover:text-white"
                }`}
              >
                <span className={isActive ? "text-[#d9ff43]" : "text-white/45"}>
                  {item.icon}
                </span>
                {!collapsed && <span>{item.label}</span>}
              </button>
            );
          })}

          {!collapsed && <div className="pt-5 pb-3 px-3 font-mono text-[9px] font-semibold text-white/35 uppercase tracking-[.2em]">
            [02 / System]
          </div>}
          <button
            onClick={() => handleItemClick("settings")}
            title={collapsed ? "Settings" : undefined}
            className={`w-full flex items-center ${collapsed ? "justify-center px-2" : "gap-3 px-3"} min-h-11 py-2 text-sm font-medium rounded-md transition-colors text-left cursor-pointer ${
              currentTab === "settings"
                ? "text-[#d9ff43] bg-white/[.06] font-semibold"
                : "text-white/55 hover:bg-white/[.04] hover:text-white"
            }`}
          >
            <Settings className="w-4 h-4 text-white/45" />
            {!collapsed && <span>Settings</span>}
          </button>

          <button
            onClick={() => handleItemClick("help")}
            title={collapsed ? "Help & Docs" : undefined}
            className={`w-full flex items-center ${collapsed ? "justify-center px-2" : "gap-3 px-3"} min-h-11 py-2 text-sm font-medium rounded-md transition-colors text-left cursor-pointer ${
              currentTab === "help"
                ? "text-[#d9ff43] bg-white/[.06] font-semibold"
                : "text-white/55 hover:bg-white/[.04] hover:text-white"
            }`}
          >
            <HelpCircle className="w-4 h-4 text-white/45" />
            {!collapsed && <span>Help & Docs</span>}
          </button>
        </nav>
      </div>

      {/* Bottom Account Profile */}
      <div className={`${collapsed ? "p-2" : "p-4"} border-t border-white/10 space-y-2`}>
        {!isDrawer && (
          <button
            onClick={onToggleCollapsed}
            className={`w-full flex items-center ${collapsed ? "justify-center" : "justify-between"} px-3 py-2 rounded-md text-xs font-semibold text-white/45 hover:text-white hover:bg-white/[.04] transition`}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {!collapsed && <span>Collapse</span>}
            {collapsed ? <ChevronsRight className="w-4 h-4" /> : <ChevronsLeft className="w-4 h-4" />}
          </button>
        )}
        <div
          onClick={() => {
            onOpenAuth();
            if (onCloseMobile) onCloseMobile();
          }}
          className={`border border-white/10 bg-white/[.04] hover:bg-white/[.08] ${collapsed ? "p-2 justify-center" : "p-3 gap-3"} rounded-lg flex items-center cursor-pointer transition`}
          title={collapsed ? "Account" : undefined}
        >
          <div className={`${isSignedIn ? "bg-[#d1d5db] text-[#374151]" : "bg-[#111827] text-white"} w-8 h-8 rounded-full font-bold text-xs flex items-center justify-center shrink-0`}>
            {isSignedIn
              ? ownerAvatar
                ? <img src={ownerAvatar} alt="RoughBid owner profile" className="w-full h-full rounded-full bg-white p-0.5 object-contain ring-1 ring-slate-200" />
                : user.name
                  .split(" ")
                  .map((n) => n[0])
                  .join("") || "JA"
              : "IN"}
          </div>
          {!collapsed && <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-white truncate">{isSignedIn ? user.name : "Sign in"}</p>
            <p className="text-[10px] text-white/45 truncate flex items-center gap-1">
              <Sparkles className="w-2.5 h-2.5 text-[#2563eb]" />
              <span>{isSignedIn ? user.plan : "Create account"}</span>
            </p>
          </div>}
        </div>
      </div>
    </>
  );
  };

  return (
    <>
      {/* Desktop Sidebar (hidden on mobile) */}
      <aside className={`hidden md:flex ${isCollapsed ? "w-16" : "w-64"} bg-[#151713] border-r border-black flex-col justify-between h-screen select-none shrink-0 transition-[width] duration-200`}>
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
          <aside className="fixed inset-y-0 left-0 w-72 max-w-[85vw] bg-[#151713] border-r border-black flex flex-col justify-between h-full shadow-2xl z-10 font-sans overflow-y-auto">
            {renderNavContent(true)}
          </aside>
        </div>
      )}
    </>
  );
};
