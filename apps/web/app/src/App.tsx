import React, { useState, useEffect, useRef } from "react";
import { Project, UserProfile, QuantityItem, PlanRevision } from "./types";
import { StorageService, persistentProject, type StorageScope } from "./utils/storage";
import { ProjectSaveQueue, type SaveState } from "./utils/projectSaveQueue";
import { projectReadiness } from "./utils/projectReadiness";
import { canWriteWorkspace } from "./utils/workspaceAccess";
import { patchProjectRevision, type RevisionPatch } from "./utils/projectRevisions";
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
import { exportClientProposalPDF } from "./utils/pdfExport";
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
  const [user, setUser] = useState<UserProfile>(() => StorageService.getUserProfile());
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState<boolean>(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("roughbid-sidebar-collapsed");
      if (saved !== null) return saved === "true";
    } catch { /* Navigation still works when browser storage is unavailable. */ }
    return window.innerWidth < 1180;
  });

  // Real Supabase Auth session. The product app is gated behind this session;
  // public access stays limited to the landing page and client proposal links.
  const { session, loading: sessionLoading } = useSession();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);
  const [workspaceState, setWorkspaceState] = useState<"loading" | "ready" | "error">("loading");
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceRetry, setWorkspaceRetry] = useState(0);
  const [loadedUserId, setLoadedUserId] = useState<string | null>(null);
  const [saveStates, setSaveStates] = useState<Record<string, { state: SaveState; message?: string }>>({});
  const [operationNotice, setOperationNotice] = useState<string | null>(null);
  const [localCacheWarning, setLocalCacheWarning] = useState(false);
  const [operationCount, setOperationCount] = useState(0);
  const projectsRef = useRef<Project[]>([]);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, left: 0 });
  }, [activeTab, activeStep, activeProject?.id]);
  const scopeRef = useRef<StorageScope | null>(null);
  const saveQueueRef = useRef<ProjectSaveQueue<Project> | null>(null);
  const deletingIds = useRef(new Set<string>());
  const attemptedCreateIds = useRef(new Set<string>());
  const canWrite = workspaceState === "ready" && loadedUserId === session?.user.id && canWriteWorkspace(workspace?.role);
  const canWriteRef = useRef(false);
  canWriteRef.current = canWrite;

  // Modal States
  const [showNewProjectModal, setShowNewProjectModal] = useState<boolean>(false);
  const [newProjectType, setNewProjectType] = useState("Deck Renovation");
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

  const selectedWorkspaceKey = (userId: string) => `roughbid_selected_workspace_v1:${encodeURIComponent(userId)}`;

  const readSelectedWorkspaceId = (userId: string): string | null => {
    try { return localStorage.getItem(selectedWorkspaceKey(userId)); }
    catch { return null; }
  };

  const saveSelectedWorkspaceId = (userId: string, workspaceId: string) => {
    try { localStorage.setItem(selectedWorkspaceKey(userId), workspaceId); }
    catch { /* Workspace choice is recoverable from the server. */ }
  };

  const isStoredProject = (value: unknown): value is Project => {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<Project>;
    return typeof candidate.name === "string" && Array.isArray(candidate.revisions) && Array.isArray(candidate.quantities) && Array.isArray(candidate.estimateItems);
  };

  const remoteToProject = (remote: RemoteProject, profile: UserProfile): Project => {
    const stored = isStoredProject(remote.app_state) ? persistentProject(remote.app_state) : null;
    const project: Project = {
      ...stored,
      id: stored?.id ?? remote.id,
      remoteId: remote.id,
      name: stored?.name ?? remote.name,
      clientName: stored?.clientName ?? "Client",
      address: stored?.address ?? remote.address_text ?? "",
      projectType: stored?.projectType ?? "Construction Project",
      status: stored?.status ?? fromRemoteStatus(remote.status),
      updatedAt: remote.updated_at ? `Updated ${new Date(remote.updated_at).toLocaleDateString()}` : stored?.updatedAt ?? "Updated recently",
      overheadPercentage: stored?.overheadPercentage ?? profile.defaultOverhead,
      markupPercentage: stored?.markupPercentage ?? profile.defaultMarkup,
      revisions: stored?.revisions ?? [],
      quantities: stored?.quantities ?? [],
      estimateItems: stored?.estimateItems ?? [],
    };
    return stored?.notes ? { ...project, notes: stored.notes } : project;
  };

  const projectPayload = (project: Project) => ({
    name: project.name,
    address: project.address,
    status: toRemoteStatus(project.status),
    appState: persistentProject(project),
  });

  const commitProjects = (next: Project[]) => {
    projectsRef.current = next;
    setProjects(next);
    if (scopeRef.current && !StorageService.saveProjects(next, scopeRef.current)) setLocalCacheWarning(true);
  };

  // Account changes invalidate the whole workspace, including in-flight saves.
  // Token refreshes for the same account must not replace newer local edits.
  useEffect(() => {
    saveQueueRef.current?.stop();
    saveQueueRef.current = null;
    scopeRef.current = null;
    projectsRef.current = [];
    setProjects([]);
    setActiveProject(null);
    setWorkspace(null);
    setLoadedUserId(null);
    setWorkspaceState("loading");
    setWorkspaceError("");
    setSaveStates({});
    setOperationNotice(null);
    setOperationCount(0);
    setLocalCacheWarning(false);
    setInviteNotice(null);
    setShowNewProjectModal(false);
    setShowAIModal(false);
    deletingIds.current.clear();
    attemptedCreateIds.current.clear();
    if (!session) {
      setUser(StorageService.getUserProfile());
      return;
    }
    let active = true;
    let queue: ProjectSaveQueue<Project> | null = null;
    const userId = session.user.id;
    (async () => {
      try {
        const auth = await bootstrapAuth();
        if (!active) return;
        const savedProfile = StorageService.getUserProfile(userId);
        const profile: UserProfile = {
          ...savedProfile,
          id: userId,
          email: session.user.email ?? "",
          name: savedProfile.name === "RoughBid Estimator" ? auth.profile.displayName ?? "RoughBid Estimator" : savedProfile.name,
        };
        setUser(profile);
        const pendingInvite = new URLSearchParams(window.location.search).get("invite");
        let invitedWorkspaceId: string | null = null;
        if (pendingInvite) {
          try {
            const accepted = await acceptWorkspaceInvite(pendingInvite);
            invitedWorkspaceId = accepted.workspaceId;
            if (!active) return;
            window.history.replaceState({}, "", window.location.pathname);
            setInviteNotice("Invite accepted. Your organization access is ready.");
          } catch (error) {
            if (!active) return;
            setInviteNotice(error instanceof Error ? error.message : "Invite could not be accepted.");
          }
        }
        const workspaces = await listWorkspaces();
        if (!active) return;
        const selectedWorkspaceId = invitedWorkspaceId ?? readSelectedWorkspaceId(userId);
        const sortedWorkspaces = [...workspaces].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        const resolved = sortedWorkspaces.find((candidate) => candidate.id === selectedWorkspaceId)
          ?? sortedWorkspaces[0]
          ?? (await createWorkspace(`${session.user.email ?? "My"} Workspace`));
        if (!active) return;
        saveSelectedWorkspaceId(userId, resolved.id);
        const remoteProjects = await listRemoteProjects(resolved.id);
        if (active) {
          const scope = { userId, workspaceId: resolved.id };
          scopeRef.current = scope;
          const mapped = remoteProjects.map((remote) => remoteToProject(remote, profile));
          const drafts = StorageService.getPendingProjects(scope);
          const writable = canWriteWorkspace(resolved.role);
          const unavailableDrafts = writable ? drafts.filter((draft) => !mapped.some((project) => draft.remoteId === project.remoteId && draft.id === project.id)) : drafts;
          // Only restore drafts whose remote project still exists in this workspace.
          const recovered = writable ? mapped.map((project) => drafts.find((draft) => draft.remoteId === project.remoteId && draft.id === project.id) ?? project) : mapped;
          queue = new ProjectSaveQueue<Project>(
            (updated) => {
              if (!canWriteRef.current) return Promise.reject(new Error("This workspace is read-only for your account."));
              return updateRemoteProject(resolved.id, updated.remoteId!, projectPayload(updated));
            },
            (id, state, error) => {
              if (!active) return;
              setSaveStates((current) => ({ ...current, [id]: { state, ...(error instanceof Error ? { message: error.message } : {}) } }));
              if (!StorageService.savePendingProject(id, queue?.getPending().find((project) => project.id === id) ?? null, scope)) setLocalCacheWarning(true);
            },
          );
          saveQueueRef.current = queue;
          for (const project of recovered) {
            if (drafts.includes(project)) queue.recover(project);
          }
          commitProjects(recovered);
          if (unavailableDrafts.length) setOperationNotice(writable ? "An earlier unsaved draft belongs to an unavailable project. Its backup is still stored in this browser." : "Earlier unsaved drafts are kept in this browser. Read-only access shows the saved workspace version.");
          setWorkspace(resolved);
          setUser({ ...profile, role: resolved.role === "admin" ? "Admin" : resolved.role === "estimator" ? "Estimator" : "Read-only" });
          setLoadedUserId(userId);
          setWorkspaceState("ready");
        }
      } catch (error) {
        if (!active) return;
        setWorkspaceError(error instanceof Error ? error.message : "Your workspace could not be loaded.");
        setWorkspaceState("error");
        setLoadedUserId(userId);
      }
    })();
    return () => {
      active = false;
      queue?.stop();
    };
  }, [session?.user.id, workspaceRetry]);

  useEffect(() => {
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      if (saveQueueRef.current?.getPending().length || operationCount > 0) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [operationCount]);

  const handleSelectTab = (tab: NavTab) => {
    setActiveTab(tab);
    setIsMobileMenuOpen(false);
    if (tab === "dashboard" || tab === "projects") {
      // Keep active project or allow opening
    }
  };

  const handleToggleSidebar = () => {
    setIsSidebarCollapsed((current) => {
      try { localStorage.setItem("roughbid-sidebar-collapsed", String(!current)); } catch { /* This preference is optional. */ }
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
    if (!canWriteRef.current || !scopeRef.current || !updated.remoteId || deletingIds.current.has(updated.id)) return;
    if (!projectsRef.current.some((project) => project.id === updated.id)) return;
    setActiveProject((current) => current?.id === updated.id ? updated : current);
    commitProjects(projectsRef.current.map((project) => project.id === updated.id ? updated : project));
    saveQueueRef.current?.enqueue(updated);
  };

  const handleAppendRevision = (projectId: string, revision: PlanRevision) => {
    if (!canWriteRef.current) return;
    const latest = projectsRef.current.find((project) => project.id === projectId);
    if (!latest) return;
    handleUpdateProject({ ...latest, revisions: [...latest.revisions.map((item) => ({ ...item, isCurrent: false })), revision] });
  };

  const handlePatchRevision = (projectId: string, revisionId: string, patch: RevisionPatch) => {
    if (!canWriteRef.current) return;
    const latest = projectsRef.current.find((project) => project.id === projectId);
    if (!latest) return;
    const updated = patchProjectRevision(latest, revisionId, patch);
    if (updated !== latest) handleUpdateProject(updated);
  };

  const handleCreateProject = async (newProject: Project, openProject = true): Promise<void> => {
    const scope = scopeRef.current;
    if (!canWriteRef.current) throw new Error("This workspace is read-only for your account.");
    if (!workspace || !scope || workspaceState !== "ready") throw new Error("Load your workspace before creating a project.");
    setOperationCount((count) => count + 1);
    setOperationNotice(null);
    try {
      // No editable local shell exists until the server confirms its identity.
      const { remoteId: _remoteId, ...draft } = newProject;
      let remote: RemoteProject | undefined;
      if (attemptedCreateIds.current.has(draft.id)) {
        // A timeout may hide a successful POST. Check its stable client ID
        // before a retry can create another server record.
        const existing = (await listRemoteProjects(workspace.id)).find((candidate) => candidate.app_state?.id === draft.id);
        if (scopeRef.current !== scope) return;
        if (existing) remote = await updateRemoteProject(workspace.id, existing.id, projectPayload(draft));
      }
      if (!remote) {
        attemptedCreateIds.current.add(draft.id);
        remote = await createRemoteProject(workspace.id, projectPayload(draft));
      }
      if (scopeRef.current !== scope) return;
      const synced = { ...draft, remoteId: remote.id, updatedAt: "Just now" };
      commitProjects([synced, ...projectsRef.current]);
      setSaveStates((current) => ({ ...current, [synced.id]: { state: "saved" } }));
      if (openProject) {
        setActiveProject(synced);
        setActiveStep("plans");
        setActiveTab("projects");
      }
    } finally {
      if (scopeRef.current === scope) setOperationCount((count) => Math.max(0, count - 1));
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    const projectToDelete = projectsRef.current.find((project) => project.id === projectId);
    const scope = scopeRef.current;
    if (!canWriteRef.current || !workspace || !scope || !projectToDelete?.remoteId || deletingIds.current.has(projectId)) return;
    if (!confirm(`Delete "${projectToDelete.name}"? This removes the project from your workspace.`)) return;
    deletingIds.current.add(projectId);
    setOperationCount((count) => count + 1);
    setOperationNotice(null);
    try {
      await saveQueueRef.current?.wait(projectId);
      if (scopeRef.current !== scope) return;
      await deleteRemoteProject(workspace.id, projectToDelete.remoteId);
      if (scopeRef.current !== scope) return;
      commitProjects(projectsRef.current.filter((project) => project.id !== projectId));
      setActiveProject((current) => current?.id === projectId ? null : current);
      setSaveStates((current) => {
        const next = { ...current };
        delete next[projectId];
        return next;
      });
    } catch (error) {
      if (scopeRef.current === scope) setOperationNotice(`Project kept. ${error instanceof Error ? error.message : "Deletion failed; try again."}`);
    } finally {
      if (scopeRef.current === scope) {
        deletingIds.current.delete(projectId);
        setOperationCount((count) => Math.max(0, count - 1));
      }
    }
  };

  const handleDuplicateProject = async (project: Project) => {
    if (!canWriteRef.current) return;
    const { remoteId: _remoteId, ...source } = project;
    const duplicated: Project = {
      ...structuredClone(source),
      id: `proj-${crypto.randomUUID()}`,
      name: `${project.name} (Copy)`,
      updatedAt: "Just now",
      revisions: [],
    };
    try {
      await handleCreateProject(duplicated, false);
      setOperationNotice("Project copied with its estimate. Upload plans separately for the new project.");
    } catch (error) {
      setOperationNotice(error instanceof Error ? error.message : "The project could not be copied.");
    }
  };

  const handleUpdateUser = (updatedUser: UserProfile) => {
    if (!canWriteRef.current) return;
    const scopedUser = { ...updatedUser, id: session?.user.id ?? "", email: session?.user.email ?? "" };
    setUser(scopedUser);
    if (!StorageService.saveUserProfile(scopedUser)) setLocalCacheWarning(true);
  };

  // AI Confirmed item addition (Requires User Confirmation). `costOverride`
  // carries the real priced material/labor cost from the AI plan-reading
  // worker. Unpriced checklist items remain at zero until the estimator sets
  // their costs; never insert invented placeholder prices into a proposal.
  const handleAddQuantityFromAI = (
    item: Omit<QuantityItem, "id" | "itemNumber">,
    costOverride?: { materialCost: number; laborCost: number }
  ) => {
    if (!canWriteRef.current) return;
    const currentProject = projectsRef.current.find((project) => project.id === activeProject?.id);
    if (!currentProject) return;

    const newId = `qty-${crypto.randomUUID()}`;
    const newQtyItem: QuantityItem = {
      ...item,
      id: newId,
      itemNumber: currentProject.quantities.length + 1,
    };

    const materialCost = costOverride?.materialCost ?? 0;
    const laborCost = costOverride?.laborCost ?? 0;
    const equipmentCost = 0;

    const newEstItem = {
      id: `est-${crypto.randomUUID()}`,
      quantityId: newId,
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      materialCost,
      laborCost,
      equipmentCost,
      directCost: Number((materialCost + laborCost + equipmentCost).toFixed(2)),
    };

    const updated: Project = {
      ...currentProject,
      quantities: [...currentProject.quantities, newQtyItem],
      estimateItems: [...currentProject.estimateItems, newEstItem],
    };

    handleUpdateProject(updated);
  };

  const handleUseTemplate = (templateName: string) => {
    if (!canWriteRef.current) return;
    setNewProjectType(templateName.includes("Deck") ? "Deck Renovation" : templateName.includes("Kitchen") ? "Kitchen Remodel" : "New Construction");
    setShowNewProjectModal(true);
  };
  const handleExportPDF = () => {
    if (!activeProject) return;
    if (!canWriteRef.current && saveQueueRef.current?.getPending().some((project) => project.id === activeProject.id)) return;
    if (!projectReadiness(activeProject).canExport) {
      setActiveStep("review");
      return;
    }
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

  if (loadedUserId !== session.user.id || workspaceState !== "ready") {
    return (
      <div className="min-h-dvh bg-slate-50 flex items-center justify-center px-5">
        <div className="max-w-md w-full rounded-2xl border border-slate-200 bg-white p-7 shadow-sm text-center">
          <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 text-lg font-black text-white">RB</div>
          <h1 className="text-xl font-bold text-slate-900">{workspaceState === "error" ? "We couldn't load your workspace" : "Opening your workspace"}</h1>
          <p className="mt-3 text-sm text-slate-600" role={workspaceState === "error" ? "alert" : "status"}>
            {workspaceState === "error" ? workspaceError : "Connecting your account and loading your projects…"}
          </p>
          {workspaceState === "error" && (
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <button className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700" onClick={() => setWorkspaceRetry((value) => value + 1)}>Try again</button>
              <button className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700" onClick={() => setShowAuthModal(true)}>Account</button>
            </div>
          )}
        </div>
        <AuthModal session={session} workspace={workspace} inviteNotice={inviteNotice} isOpen={showAuthModal} onClose={() => setShowAuthModal(false)} />
      </div>
    );
  }

  const pendingSaveEntries = Object.entries(saveStates).filter(([, value]) => value.state !== "saved");
  const saveErrors = pendingSaveEntries.filter(([, value]) => value.state === "error");

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
          canWrite={canWrite}
          pageTitle={{ dashboard: "Dashboard", projects: "Projects", materials: "Materials", assemblies: "Assemblies", pricelists: "Price Lists", billing: "Billing", templates: "Templates", settings: "Settings", help: "Help" }[activeTab]}
          project={activeTab === "projects" ? activeProject : null}
          activeStep={activeStep}
          onSelectStep={(step) => setActiveStep(step)}
          onBackToProjects={handleBackToProjects}
          onExportPDF={handleExportPDF}
          onCreateEstimate={handleCreateEstimate}
          onOpenNewProject={() => { if (canWriteRef.current) setShowNewProjectModal(true); }}
          onToggleMobileMenu={() => setIsMobileMenuOpen((prev) => !prev)}
          user={user}
          onOpenAuth={() => setShowAuthModal(true)}
          isSignedIn={session !== null}
        />

        {!canWrite && <div className="border-b border-blue-200 bg-blue-50 px-4 sm:px-6 py-3 text-sm text-blue-950" role="status">Read-only workspace. You can review saved projects and download their estimates. Editing and sharing new proposal links require an estimator or admin role.</div>}

        <div className="border-b border-slate-200 bg-white px-4 sm:px-6 py-2 text-xs flex flex-wrap items-center gap-x-4 gap-y-2" aria-live="polite">
          <span className={saveErrors.length ? "font-semibold text-amber-800" : "text-slate-500"}>
            {operationCount > 0 ? "Saving project changes…" : saveErrors.length ? `${saveErrors.length} project${saveErrors.length > 1 ? "s" : ""} with unsaved changes` : pendingSaveEntries.length ? "Saving changes…" : "All changes saved"}
          </span>
          {saveErrors.length > 0 && <button className="font-semibold text-blue-600 underline" onClick={() => saveErrors.forEach(([id]) => saveQueueRef.current?.retry(id))}>Retry saving</button>}
          {operationNotice && <span role="status" className="text-slate-700">{operationNotice}</span>}
          {localCacheWarning && <span className="text-amber-800" role="alert">Browser backup is unavailable. Keep this tab open until changes are saved.</span>}
        </div>
        {saveErrors.length > 0 && <div className="border-b border-amber-200 bg-amber-50 px-4 sm:px-6 py-2 text-xs text-amber-900" role="alert">{saveErrors[0]?.[1].message ?? "Changes remain in this browser. Retry saving before leaving."}</div>}

        {/* Dynamic Page Views */}
        <main ref={mainRef} className="flex-1 overflow-y-auto min-w-0">
          {activeTab === "dashboard" && (
            <DashboardPage
              canWrite={canWrite}
              projects={projects}
              onOpenProject={handleOpenProject}
              onNewProject={() => { if (canWriteRef.current) setShowNewProjectModal(true); }}
            />
          )}

          {activeTab === "projects" && (
            <>
              {!activeProject ? (
                <ProjectsPage
                  canWrite={canWrite}
                  projects={projects}
                  onOpenProject={handleOpenProject}
                  onNewProject={() => { if (canWriteRef.current) setShowNewProjectModal(true); }}
                  onDeleteProject={handleDeleteProject}
                  onDuplicateProject={handleDuplicateProject}
                />
              ) : (
                <>
                  {activeStep === "plans" && (
                    <PlansPage
                      canWrite={canWrite}
                      onAppendRevision={(revision) => handleAppendRevision(activeProject.id, revision)}
                      onPatchRevision={(revisionId, patch) => handlePatchRevision(activeProject.id, revisionId, patch)}
                      key={`${workspace?.id}:${activeProject.remoteId}:${activeProject.id}`}
                      project={activeProject}
                      workspaceId={workspace?.id ?? null}
                      onUpdateProject={handleUpdateProject}
                      onContinue={() => setActiveStep("quantities")}
                      onOpenAIAssistant={() => setShowAIModal(true)}
                    />
                  )}

                  {activeStep === "quantities" && (
                    <QuantitiesPage
                      canWrite={canWrite}
                      project={activeProject}
                      onUpdateProject={handleUpdateProject}
                      onContinue={() => setActiveStep("estimate")}
                      onSelectStep={(step) => setActiveStep(step)}
                      onOpenAIAssistant={() => setShowAIModal(true)}
                    />
                  )}

                  {activeStep === "estimate" && (
                    <EstimatePage
                      canWrite={canWrite}
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
                      canPublish={canWrite}
                      project={activeProject}
                      isProjectSaved={!saveQueueRef.current?.getPending().some((project) => project.id === activeProject.id)}
                      workspaceId={workspace?.id ?? null}
                      onSelectStep={(step) => setActiveStep(step)}
                    />
                  )}
                </>
              )}
            </>
          )}

          {/* Secondary Views */}
          {activeTab === "materials" && <MaterialsPage scope={scopeRef.current!} canWrite={canWrite} />}
          {activeTab === "assemblies" && <AssembliesPage scope={scopeRef.current!} canWrite={canWrite} />}
          {activeTab === "pricelists" && <PriceListsPage scope={scopeRef.current!} onOpenMaterials={() => setActiveTab("materials")} />}
          {activeTab === "billing" && <fieldset disabled={!canWrite}><BillingPage /></fieldset>}
          {activeTab === "templates" && (
            <fieldset disabled={!canWrite}><TemplatesPage onUseTemplate={handleUseTemplate} /></fieldset>
          )}
          {activeTab === "settings" && (
            <fieldset disabled={!canWrite}><SettingsPage user={user} onUpdateUser={handleUpdateUser} /></fieldset>
          )}
          {activeTab === "help" && <HelpPage />}
        </main>
      </div>

      {/* New Project Creation Modal */}
      {canWrite && showNewProjectModal && <NewProjectModal
        isOpen={showNewProjectModal}
        onClose={() => setShowNewProjectModal(false)}
        onCreate={handleCreateProject}
        initialProjectType={newProjectType}
        defaultOverhead={user.defaultOverhead}
        defaultMarkup={user.defaultMarkup}
      />}

      {/* AI Estimator Modal (if active project selected) */}
      {canWrite && activeProject && (
        <AIPlanModal
          project={activeProject}
          workspaceId={workspace?.id ?? null}
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
