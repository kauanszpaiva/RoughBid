import React, { useState, useEffect } from "react";
import { Project, UserProfile, QuantityItem } from "./types";
import { StorageService } from "./utils/storage";
import { Sidebar, NavTab } from "./components/Sidebar";
import { Header, ProjectStep } from "./components/Header";
import { DashboardPage } from "./pages/DashboardPage";
import { PlansPage } from "./pages/PlansPage";
import { QuantitiesPage } from "./pages/QuantitiesPage";
import { EstimatePage } from "./pages/EstimatePage";
import { ReviewPage } from "./pages/ReviewPage";
import { ExportPage } from "./pages/ExportPage";
import { MaterialsPage } from "./pages/MaterialsPage";
import { AssembliesPage } from "./pages/AssembliesPage";
import { PriceListsPage } from "./pages/PriceListsPage";
import { TemplatesPage } from "./pages/TemplatesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { HelpPage } from "./pages/HelpPage";
import { NewProjectModal } from "./components/NewProjectModal";
import { AIPlanModal } from "./components/AIPlanModal";
import { AuthModal } from "./components/AuthModal";
import { exportClientProposalPDF, exportInternalEstimatePDF } from "./utils/pdfExport";
import { useSession } from "./services/useSession";
import { acceptWorkspaceInvite, bootstrapAuth, createProject as createRemoteProject, createWorkspace, listWorkspaces, type RemoteProject, type Workspace } from "./services/api";

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [activeTab, setActiveTab] = useState<NavTab>("projects");
  const [activeStep, setActiveStep] = useState<ProjectStep>("plans");
  const [user, setUser] = useState<UserProfile>(StorageService.getUserProfile());
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState<boolean>(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(() => localStorage.getItem("roughbid-sidebar-collapsed") === "true");

  // Real Supabase Auth session (null when signed out or when auth isn't
  // configured in this environment — see services/supabaseClient.ts). The
  // rest of the app keeps working on local mock data either way; signing in
  // only additionally provisions/reads a real backend workspace, below.
  const { session } = useSession();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);

  // Modal States
  const [showNewProjectModal, setShowNewProjectModal] = useState<boolean>(false);
  const [showAIModal, setShowAIModal] = useState<boolean>(false);
  const [showAuthModal, setShowAuthModal] = useState<boolean>(false);

  // Initialize projects on load
  useEffect(() => {
    const loaded = StorageService.getProjects();
    setProjects(loaded);
  }, []);

  // Once signed in, resolve the user's real backend workspace (creating one
  // the first time), so real projects created below have somewhere to live.
  // This intentionally does not replace the local project list above yet —
  // the backend `projects` table doesn't carry the full plans/quantities/
  // estimate-items shape this app already works with (see api.ts and
  // storage.ts TODOs) — it only proves and keeps the real auth chain wired.
  useEffect(() => {
    if (!session) {
      setWorkspace(null);
      return;
    }
    let active = true;
    (async () => {
      try {
        await bootstrapAuth();
        const pendingInvite = new URLSearchParams(window.location.search).get("invite");
        if (pendingInvite) {
          try {
            await acceptWorkspaceInvite(pendingInvite);
            window.history.replaceState({}, "", window.location.pathname);
            setInviteNotice("Invite accepted. Your organization access is ready.");
          } catch (error) {
            setInviteNotice(error instanceof Error ? error.message : "Invite could not be accepted.");
          }
        }
        const workspaces = await listWorkspaces();
        const resolved = workspaces[0] ?? (await createWorkspace(`${session.user.email ?? "My"} Workspace`));
        if (active) setWorkspace(resolved);
      } catch (error) {
        console.error("Could not resolve your workspace from the backend.", error);
      }
    })();
    return () => {
      active = false;
    };
  }, [session]);

  const handleSelectTab = (tab: NavTab) => {
    setActiveTab(tab);
    setIsMobileMenuOpen(false);
    if (tab === "dashboard" || tab === "projects") {
      // Keep active project or allow opening
    }
  };

  const handleToggleSidebar = () => {
    setIsSidebarCollapsed((current) => {
      localStorage.setItem("roughbid-sidebar-collapsed", String(!current));
      return !current;
    });
  };

  const handleOpenProject = (project: Project) => {
    setActiveProject(project);
    setActiveStep("plans");
    setActiveTab("projects");
    setIsMobileMenuOpen(false);
  };

  const handleBackToProjects = () => {
    setActiveProject(null);
    setActiveTab("projects");
  };

  const handleUpdateProject = (updated: Project) => {
    setActiveProject(updated);
    const newProjects = projects.map((p) => (p.id === updated.id ? updated : p));
    setProjects(newProjects);
    StorageService.saveProjects(newProjects);
  };

  const handleCreateProject = (newProject: Project) => {
    const newProjects = [newProject, ...projects];
    setProjects(newProjects);
    StorageService.saveProjects(newProjects);
    setActiveProject(newProject);
    setActiveStep("plans");
    setActiveTab("projects");

    // Best-effort: also register the project with the real backend once a
    // workspace is resolved, so a growing, real `projects` table exists
    // alongside the local mock. Never blocks or fails the UI — see the
    // effect above and api.ts for why this app doesn't yet read projects
    // back from the backend.
    if (workspace) {
      createRemoteProject(workspace.id, { name: newProject.name, address: newProject.address }).then((remote) => {
        const remoteProject = remote as RemoteProject;
        const synced = { ...newProject, remoteId: remoteProject.id };
        setActiveProject((current) => current?.id === newProject.id ? synced : current);
        setProjects((current) => {
          const next = current.map((project) => project.id === newProject.id ? synced : project);
          StorageService.saveProjects(next);
          return next;
        });
      }).catch((error) => {
        console.error("Could not sync this project to the backend.", error);
      });
    }
  };

  const handleDeleteProject = (projectId: string) => {
    if (confirm("Are you sure you want to delete this project?")) {
      const updated = projects.filter((p) => p.id !== projectId);
      setProjects(updated);
      StorageService.saveProjects(updated);
      if (activeProject?.id === projectId) {
        setActiveProject(null);
      }
    }
  };

  const handleDuplicateProject = (project: Project) => {
    const duplicated: Project = {
      ...project,
      id: `proj-${Date.now()}`,
      name: `${project.name} (Copy)`,
      updatedAt: "Just now",
    };
    const updated = [duplicated, ...projects];
    setProjects(updated);
    StorageService.saveProjects(updated);
  };

  const handleUpdateUser = (updatedUser: UserProfile) => {
    setUser(updatedUser);
    StorageService.saveUserProfile(updatedUser);
  };

  // AI Confirmed item addition (Requires User Confirmation)
  const handleAddQuantityFromAI = (item: Omit<QuantityItem, "id" | "itemNumber">) => {
    if (!activeProject) return;

    const newId = `qty-${Date.now()}`;
    const newQtyItem: QuantityItem = {
      ...item,
      id: newId,
      itemNumber: activeProject.quantities.length + 1,
    };

    const newEstItem = {
      id: `est-${Date.now()}`,
      quantityId: newId,
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      materialCost: Number((item.quantity * 2.2).toFixed(2)),
      laborCost: Number((item.quantity * 1.8).toFixed(2)),
      equipmentCost: Number((item.quantity * 0.2).toFixed(2)),
      directCost: Number((item.quantity * 4.2).toFixed(2)),
    };

    const updated: Project = {
      ...activeProject,
      quantities: [...activeProject.quantities, newQtyItem],
      estimateItems: [...activeProject.estimateItems, newEstItem],
    };

    handleUpdateProject(updated);
  };

  const handleUseTemplate = (templateName: string) => {
    const newProj: Project = {
      id: `proj-${Date.now()}`,
      name: `New ${templateName} Project`,
      clientName: "Prospective Client",
      address: "100 Construction Way",
      projectType: templateName.includes("Deck") ? "Deck Renovation" : "Remodel",
      status: "Planning",
      updatedAt: "Just now",
      overheadPercentage: user.defaultOverhead,
      markupPercentage: user.defaultMarkup,
      revisions: [
        {
          id: `rev-${Date.now()}`,
          revisionNumber: "01",
          fileName: `${templateName.replace(/\s+/g, "_")}_Plans.pdf`,
          fileSize: "16.0 MB",
          pages: 12,
          uploadDate: new Date().toLocaleDateString(),
          uploadedBy: user.name,
          isCurrent: true,
        },
      ],
      quantities: [
        { id: `qty-1`, itemNumber: 1, name: "Framing & Structural", quantity: 600, unit: "LF", category: "Framing" },
        { id: `qty-2`, itemNumber: 2, name: "Surface Decking & Planks", quantity: 450, unit: "SF", category: "Finishes" },
        { id: `qty-3`, itemNumber: 3, name: "Perimeter Railing System", quantity: 64, unit: "LF", category: "Finishes" },
      ],
      estimateItems: [
        { id: `est-1`, quantityId: `qty-1`, csiCode: "06 11 00", name: "06 11 00 - Framing", quantity: 600, unit: "LF", materialCost: 2200, laborCost: 1900, equipmentCost: 200, directCost: 4300 },
        { id: `est-2`, quantityId: `qty-2`, csiCode: "06 15 00", name: "06 15 00 - Composite Decking", quantity: 450, unit: "SF", materialCost: 3200, laborCost: 2100, equipmentCost: 100, directCost: 5400 },
      ],
    };

    handleCreateProject(newProj);
  };

  const handleExportPDF = () => {
    if (!activeProject) return;
    exportClientProposalPDF(activeProject);
  };

  const handleCreateEstimate = () => {
    if (!activeProject) return;
    setActiveStep("estimate");
  };

  return (
    <div className="flex h-screen bg-[#fcfcfd] text-slate-900 overflow-hidden font-sans">
      {/* Sidebar */}
      <Sidebar
        currentTab={activeTab}
        onSelectTab={handleSelectTab}
        user={user}
        onOpenAuth={() => setShowAuthModal(true)}
        isMobileOpen={isMobileMenuOpen}
        onCloseMobile={() => setIsMobileMenuOpen(false)}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapsed={handleToggleSidebar}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
        {/* Top Header */}
        <Header
          project={activeTab === "projects" ? activeProject : null}
          activeStep={activeStep}
          onSelectStep={(step) => setActiveStep(step)}
          onBackToProjects={handleBackToProjects}
          onExportPDF={handleExportPDF}
          onCreateEstimate={handleCreateEstimate}
          onOpenNewProject={() => setShowNewProjectModal(true)}
          onToggleMobileMenu={() => setIsMobileMenuOpen((prev) => !prev)}
          user={user}
          onOpenAuth={() => setShowAuthModal(true)}
        />

        {/* Dynamic Page Views */}
        <main className="flex-1 overflow-y-auto">
          {/* Projects or Dashboard Main Workflow */}
          {(activeTab === "dashboard" || activeTab === "projects") && (
            <>
              {!activeProject ? (
                <DashboardPage
                  projects={projects}
                  onOpenProject={handleOpenProject}
                  onNewProject={() => setShowNewProjectModal(true)}
                  onDeleteProject={handleDeleteProject}
                  onDuplicateProject={handleDuplicateProject}
                />
              ) : (
                <>
                  {activeStep === "plans" && (
                    <PlansPage
                      project={activeProject}
                      workspaceId={workspace?.id ?? null}
                      onUpdateProject={handleUpdateProject}
                      onContinue={() => setActiveStep("quantities")}
                      onOpenAIAssistant={() => setShowAIModal(true)}
                    />
                  )}

                  {activeStep === "quantities" && (
                    <QuantitiesPage
                      project={activeProject}
                      onUpdateProject={handleUpdateProject}
                      onContinue={() => setActiveStep("estimate")}
                      onSelectStep={(step) => setActiveStep(step)}
                      onOpenAIAssistant={() => setShowAIModal(true)}
                    />
                  )}

                  {activeStep === "estimate" && (
                    <EstimatePage
                      project={activeProject}
                      onUpdateProject={handleUpdateProject}
                      onContinue={() => setActiveStep("review")}
                      onSelectStep={(step) => setActiveStep(step)}
                      onOpenAIAssistant={() => setShowAIModal(true)}
                    />
                  )}

                  {activeStep === "review" && (
                    <ReviewPage
                      project={activeProject}
                      onContinue={() => setActiveStep("export")}
                      onBack={() => setActiveStep("estimate")}
                      onSelectStep={(step) => setActiveStep(step)}
                      onOpenAIAssistant={() => setShowAIModal(true)}
                    />
                  )}

                  {activeStep === "export" && (
                    <ExportPage
                      project={activeProject}
                      onSelectStep={(step) => setActiveStep(step)}
                    />
                  )}
                </>
              )}
            </>
          )}

          {/* Secondary Views */}
          {activeTab === "materials" && <MaterialsPage />}
          {activeTab === "assemblies" && <AssembliesPage />}
          {activeTab === "pricelists" && <PriceListsPage />}
          {activeTab === "templates" && (
            <TemplatesPage onUseTemplate={handleUseTemplate} />
          )}
          {activeTab === "settings" && (
            <SettingsPage user={user} onUpdateUser={handleUpdateUser} />
          )}
          {activeTab === "help" && <HelpPage />}
        </main>
      </div>

      {/* New Project Creation Modal */}
      <NewProjectModal
        isOpen={showNewProjectModal}
        onClose={() => setShowNewProjectModal(false)}
        onCreate={handleCreateProject}
      />

      {/* AI Estimator Modal (if active project selected) */}
      {activeProject && (
        <AIPlanModal
          project={activeProject}
          isOpen={showAIModal}
          onClose={() => setShowAIModal(false)}
          onAddQuantityItem={handleAddQuantityFromAI}
          initialTab={
            activeStep === "plans"
              ? "analyze"
              : activeStep === "quantities"
              ? "missing"
              : "explain"
          }
        />
      )}

      {/* Account / sign-in modal */}
      <AuthModal
        session={session}
        workspace={workspace}
        inviteNotice={inviteNotice}
        isOpen={showAuthModal}
        onClose={() => setShowAuthModal(false)}
      />
    </div>
  );
}
