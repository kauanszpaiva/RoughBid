import React, { useState, useEffect } from "react";
import { Project, UserProfile, QuantityItem } from "./types";
import { StorageService } from "./utils/storage";
import { Sidebar, NavTab } from "./components/Sidebar";
import { Header, ProjectStep } from "./components/Header";
import { DashboardPage } from "./pages/DashboardPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { PlansPage } from "./pages/PlansPage";
import { QuantitiesPage } from "./pages/QuantitiesPage";
import { EstimatePage } from "./pages/EstimatePage";
import { ReviewPage } from "./pages/ReviewPage";
import { ExportPage } from "./pages/ExportPage";
import { MaterialsPage } from "./pages/MaterialsPage";
import { AssembliesPage } from "./pages/AssembliesPage";
import { PriceListsPage } from "./pages/PriceListsPage";
import { BillingPage } from "./pages/BillingPage";
import { TemplatesPage } from "./pages/TemplatesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { HelpPage } from "./pages/HelpPage";
import { ClientProposalPage } from "./pages/ClientProposalPage";
import { NewProjectModal } from "./components/NewProjectModal";
import { AIPlanModal } from "./components/AIPlanModal";
import { AuthModal } from "./components/AuthModal";
import { AuthGate } from "./components/AuthGate";
import { exportClientProposalPDF, exportInternalEstimatePDF } from "./utils/pdfExport";
import { useSession } from "./services/useSession";
import { isAuthConfigured } from "./services/supabaseClient";
import {
  acceptWorkspaceInvite,
  bootstrapAuth,
  createProject as createRemoteProject,
  createWorkspace,
  deleteProject as deleteRemoteProject,
  listProjects as listRemoteProjects,
  listWorkspaces,
  updateProject as updateRemoteProject,
  type RemoteProject,
  type Workspace,
} from "./services/api";

export default function App() {
  const publicProposalMatch = window.location.pathname.match(/^\/proposal\/([A-Za-z0-9_-]+)$/);
  if (publicProposalMatch?.[1]) {
    return <ClientProposalPage token={publicProposalMatch[1]} />;
  }

  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [activeTab, setActiveTab] = useState<NavTab>("projects");
  const [activeStep, setActiveStep] = useState<ProjectStep>("plans");
  const [user, setUser] = useState<UserProfile>(StorageService.getUserProfile());
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState<boolean>(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(() => {
    const saved = localStorage.getItem("roughbid-sidebar-collapsed");
    if (saved !== null) return saved === "true";
    return window.innerWidth < 1180;
  });

  // Real Supabase Auth session. The product app is gated behind this session;
  // public access stays limited to the landing page and client proposal links.
  const { session, loading: sessionLoading } = useSession();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaceNotice, setWorkspaceNotice] = useState<string | null>(null);
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    const stored = StorageService.getUserProfile();
    const email = session.user.email ?? '';
    const profile: UserProfile = stored.id === session.user.id ? { ...stored, email } : {
      id: session.user.id,
      name: String(session.user.user_metadata?.full_name ?? email.split('@')[0] ?? 'Estimator'),
      email, role: 'Estimator', plan: 'RoughBid', company: '', defaultOverhead: 12, defaultMarkup: 20,
    };
    StorageService.saveUserProfile(profile);
    setUser(profile);
  }, [session?.user.id]);

  // Modal States
  const [showNewProjectModal, setShowNewProjectModal] = useState<boolean>(false);
  const [showAIModal, setShowAIModal] = useState<boolean>(false);
  const [showAuthModal, setShowAuthModal] = useState<boolean>(false);

  const toRemoteStatus = (status: Project["status"]) => {
    if (status === "Completed") return "archived";
    if (status === "In Progress") return "active";
    return "draft";
  };

  const fromRemoteStatus = (status?: RemoteProject["status"]): Project["status"] => {
    if (status === "archived") return "Completed";
    if (status === "active") return "In Progress";
    return "Planning";
  };

  const isStoredProject = (value: unknown): value is Project => {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<Project>;
    return typeof candidate.name === "string" && Array.isArray(candidate.revisions) && Array.isArray(candidate.quantities) && Array.isArray(candidate.estimateItems);
  };

  const remoteToProject = (remote: RemoteProject): Project => {
    const stored = isStoredProject(remote.app_state) ? remote.app_state : null;
    const project: Project = {
      id: stored?.id ?? remote.id,
      remoteId: remote.id,
      name: stored?.name ?? remote.name,
      clientName: stored?.clientName ?? "Client",
      address: stored?.address ?? remote.address_text ?? "",
      projectType: stored?.projectType ?? "Construction Project",
      status: stored?.status ?? fromRemoteStatus(remote.status),
      updatedAt: remote.updated_at ? `Updated ${new Date(remote.updated_at).toLocaleDateString()}` : stored?.updatedAt ?? "Updated recently",
      overheadPercentage: stored?.overheadPercentage ?? user.defaultOverhead,
      markupPercentage: stored?.markupPercentage ?? user.defaultMarkup,
      revisions: stored?.revisions ?? [],
      quantities: stored?.quantities ?? [],
      estimateItems: stored?.estimateItems ?? [],
    };
    return stored?.notes ? { ...project, notes: stored.notes } : project;
  };

  const stripTransientProjectState = (project: Project): Project => ({
    ...project,
    revisions: project.revisions.map(({ fileUrl: _fileUrl, ...revision }) => revision),
  });

  const projectStorageScope = session && workspace ? `${session.user.id}:${workspace.id}` : null;

  const saveScopedProjects = (next: Project[]) => {
    if (projectStorageScope) StorageService.saveProjectsForScope(projectStorageScope, next.map(stripTransientProjectState));
  };

  const projectPayload = (project: Project) => ({
    name: project.name,
    address: project.address,
    status: toRemoteStatus(project.status),
    appState: stripTransientProjectState(project),
  });

  // Once signed in, resolve the user's real backend workspace (creating one
  // the first time), so real projects created below have somewhere to live.
  // This intentionally does not replace the local project list above yet —
  // the backend `projects` table doesn't carry the full plans/quantities/
  // estimate-items shape this app already works with (see api.ts and
  // storage.ts TODOs) — it only proves and keeps the real auth chain wired.
  useEffect(() => {
    if (!session) {
      setWorkspace(null);
      setWorkspaceNotice(null);
      setProjects([]);
      setActiveProject(null);
      return;
    }
    let active = true;
    (async () => {
      try {
        setWorkspaceNotice("Loading your private workspace...");
        try {
          await bootstrapAuth();
        } catch (error) {
          console.warn("Profile bootstrap is delayed; continuing workspace setup.", error);
          setWorkspaceNotice("Your profile is still syncing. RoughBid is opening your workspace anyway.");
        }
        const pendingInvite = new URLSearchParams(window.location.search).get("invite");
        let invitedWorkspaceId: string | null = null;
        if (pendingInvite) {
          try {
            const accepted = await acceptWorkspaceInvite(pendingInvite);
            invitedWorkspaceId = accepted.workspaceId;
            window.history.replaceState({}, "", window.location.pathname);
            setInviteNotice("Invite accepted. Your organization access is ready.");
          } catch (error) {
            setInviteNotice(error instanceof Error ? error.message : "Invite could not be accepted.");
          }
        }
        const workspaces = await listWorkspaces();
        const resolved = (invitedWorkspaceId ? workspaces.find((item) => item.id === invitedWorkspaceId) : null)
          ?? workspaces[0]
          ?? (await createWorkspace(`${session.user.email ?? "My"} Workspace`));
        if (!active) return;
        setWorkspace(resolved);
        setWorkspaceNotice(null);
        const scopedCacheKey = `${session.user.id}:${resolved.id}`;
        const cachedProjects = StorageService.getProjectsForScope(scopedCacheKey);
        setProjects(cachedProjects);
        setActiveProject(current => current ? cachedProjects.find(project => project.id === current.id || project.remoteId === current.remoteId) ?? current : current);
        const remoteProjects = await listRemoteProjects(resolved.id);
        if (active) {
          const mapped = remoteProjects.map(remoteToProject);
          setProjects(mapped);
          setActiveProject(current => current ? mapped.find(project => project.id === current.id || project.remoteId === current.remoteId) ?? current : current);
          StorageService.saveProjectsForScope(scopedCacheKey, mapped);
        }
      } catch (error) {
        console.error("Could not resolve your workspace from the backend.", error);
        if (active) {
          setWorkspace(null);
          setWorkspaceNotice(error instanceof Error ? error.message : "Could not load your RoughBid workspace.");
          setProjects([]);
          setActiveProject(null);
        }
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
    setActiveProject(current => current?.id === updated.id ? updated : current);
    setProjects(current => {
      const next = current.map(p => p.id === updated.id ? updated : p);
      saveScopedProjects(next);
      return next;
    });
    if (workspace && updated.remoteId) {
      updateRemoteProject(workspace.id, updated.remoteId, projectPayload(updated)).catch((error) => {
        console.error("Could not persist this project to the backend.", error);
      });
    }
  };

  const handleEnsureProjectSynced = async (project: Project): Promise<Project | null> => {
    if (!workspace) return null;
    if (project.remoteId) return project;

    const remote = await createRemoteProject(workspace.id, projectPayload(project));
    const synced = { ...project, remoteId: remote.id, updatedAt: "Just now" };
    setActiveProject((current) => current?.id === project.id ? synced : current);
    setProjects((current) => {
      const next = current.map((item) => item.id === project.id ? synced : item);
      saveScopedProjects(next);
      return next;
    });
    return synced;
  };

  const handleCreateProject = (newProject: Project) => {
    if (!workspace) {
      alert(workspaceNotice ?? "Your RoughBid workspace is still loading. Try again in a moment.");
      return;
    }
    const stagedProject = { ...newProject, updatedAt: "Saving..." };
    const newProjects = [stagedProject, ...projects];
    setProjects(newProjects);
    saveScopedProjects(newProjects);
    setActiveProject(stagedProject);
    setActiveStep("plans");
    setActiveTab("projects");

    createRemoteProject(workspace.id, projectPayload(stagedProject)).then((remote) => {
      const remoteProject = remote as RemoteProject;
      const synced = { ...stagedProject, remoteId: remoteProject.id, updatedAt: "Just now" };
      setActiveProject((current) => current?.id === newProject.id ? synced : current);
      setProjects((current) => {
        const next = current.map((project) => project.id === newProject.id ? synced : project);
        saveScopedProjects(next);
        return next;
      });
    }).catch((error) => {
      console.error("Could not sync this project to the backend.", error);
    });
  };

  const handleDeleteProject = (projectId: string) => {
    if (confirm("Are you sure you want to delete this project?")) {
      const projectToDelete = projects.find((p) => p.id === projectId);
      const updated = projects.filter((p) => p.id !== projectId);
      setProjects(updated);
      saveScopedProjects(updated);
      if (workspace && projectToDelete?.remoteId) {
        deleteRemoteProject(workspace.id, projectToDelete.remoteId).catch((error) => {
          console.error("Could not delete this project from the backend.", error);
        });
      }
      if (activeProject?.id === projectId) {
        setActiveProject(null);
      }
    }
  };

  const handleDuplicateProject = (project: Project) => {
    if (!workspace) {
      alert(workspaceNotice ?? "Your RoughBid workspace is still loading. Try again in a moment.");
      return;
    }
    const { remoteId: _remoteId, ...sourceProject } = project;
    const duplicated: Project = {
      ...sourceProject,
      id: `proj-${Date.now()}`,
      name: `${project.name} (Copy)`,
      updatedAt: "Just now",
    };
    const updated = [duplicated, ...projects];
    setProjects(updated);
    saveScopedProjects(updated);
    createRemoteProject(workspace.id, projectPayload(duplicated)).then((remote) => {
      const synced = { ...duplicated, remoteId: remote.id };
      setProjects((current) => {
        const next = current.map((project) => project.id === duplicated.id ? synced : project);
        saveScopedProjects(next);
        return next;
      });
    }).catch((error) => {
      console.error("Could not persist duplicated project to the backend.", error);
    });
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

  if (isAuthConfigured && sessionLoading) {
    return (
      <div className="min-h-screen bg-[#f8fafc] flex items-center justify-center text-sm font-semibold text-slate-600">
        Loading RoughBid...
      </div>
    );
  }

  if (!session) {
    return <AuthGate />;
  }

  return (
    <div className="flex h-dvh bg-[#fcfcfd] text-slate-900 overflow-hidden font-sans">
      {/* Sidebar */}
      <Sidebar
        currentTab={activeTab}
        onSelectTab={handleSelectTab}
        user={user}
        onOpenAuth={() => setShowAuthModal(true)}
        isSignedIn={session !== null}
        isMobileOpen={isMobileMenuOpen}
        onCloseMobile={() => setIsMobileMenuOpen(false)}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapsed={handleToggleSidebar}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 h-dvh overflow-hidden">
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
          isSignedIn={session !== null}
        />

        {/* Dynamic Page Views */}
        <main className="flex-1 overflow-y-auto">
          {activeTab === "dashboard" && (
            <DashboardPage
              projects={projects}
              onOpenProject={handleOpenProject}
              onNewProject={() => setShowNewProjectModal(true)}
            />
          )}

          {activeTab === "projects" && (
            <>
              {!activeProject ? (
                <ProjectsPage
                  projects={projects}
                  onOpenProject={handleOpenProject}
                  onNewProject={() => setShowNewProjectModal(true)}
                  onDeleteProject={handleDeleteProject}
                  onDuplicateProject={handleDuplicateProject}
                  workspaceNotice={workspaceNotice}
                  isWorkspaceReady={workspace !== null}
                />
              ) : (
                <>
                  {activeStep === "plans" && (
                    <PlansPage
                      project={activeProject}
                      workspaceId={workspace?.id ?? null}
                      onUpdateProject={handleUpdateProject}
                      onEnsureProjectSynced={handleEnsureProjectSynced}
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
                      workspaceId={workspace?.id ?? null}
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
          {activeTab === "billing" && <BillingPage />}
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
          onOpenPlans={() => { setShowAIModal(false); setActiveStep("plans"); setActiveTab("projects"); }}
          workspaceId={workspace?.id ?? null}
          onUpdateProject={handleUpdateProject}
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
