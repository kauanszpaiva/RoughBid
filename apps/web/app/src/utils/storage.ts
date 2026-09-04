import type {
  Project,
  MaterialItem,
  AssemblyItem,
  PriceList,
  UserProfile,
} from "../types";

// Local workspace state used after authentication for UI-first estimating
// screens whose full backend contract is still being widened. Server-backed
// workspace creation, project shell creation, uploads, AI jobs, proposals,
// invites, billing, and policy gates stay in services/api.ts and apps/api.

const STORAGE_KEY_PROJECTS = "roughbid_projects_v1";
const STORAGE_KEY_PROJECT_SCOPE_PREFIX = "roughbid_projects_scope_v1";
const STORAGE_KEY_MATERIALS = "roughbid_materials_v1";
const STORAGE_KEY_ASSEMBLIES = "roughbid_assemblies_v1";
const STORAGE_KEY_PRICELISTS = "roughbid_pricelists_v1";
const STORAGE_KEY_USER = "roughbid_user_v1";

export const INITIAL_USER: UserProfile = {
  id: "user-1",
  name: "RoughBid Estimator",
  email: "estimator@roughbid.app",
  role: "Lead Estimator",
  plan: "RoughBid SaaS",
  company: "KSP Ventures",
  licenseNumber: "GC-94021",
  defaultOverhead: 12,
  defaultMarkup: 20,
};

export const INITIAL_PROJECTS: Project[] = [
  {
    id: "proj-1",
    name: "Smith Residence — Deck Renovation",
    clientName: "J. Smith",
    address: "124 Maple Street",
    projectType: "Deck Renovation",
    status: "In Progress",
    updatedAt: "Updated 2h ago",
    overheadPercentage: 12,
    markupPercentage: 20,
    revisions: [
      {
        id: "rev-1",
        revisionNumber: "01",
        fileName: "Deck_Plans_Initial.pdf",
        fileSize: "16.2 MB",
        pages: 20,
        uploadDate: "Aug 15, 2026",
        uploadedBy: "J. Smith",
        isCurrent: false,
        notes: "Initial conceptual draft from architect",
      },
      {
        id: "rev-2",
        revisionNumber: "02",
        fileName: "Deck_Plans_Structural_Rev2.pdf",
        fileSize: "17.8 MB",
        pages: 22,
        uploadDate: "Aug 24, 2026",
        uploadedBy: "J. Smith",
        isCurrent: false,
        notes: "Updated beam sizing and ledger attachments",
      },
      {
        id: "rev-3",
        revisionNumber: "03",
        fileName: "Deck_Plans.pdf",
        fileSize: "18.4 MB",
        pages: 24,
        uploadDate: "Sep 2, 2026",
        uploadedBy: "J. Smith",
        isCurrent: true,
        notes: "Issued for construction - final structural engineer stamp",
      },
    ],
    quantities: [
      { id: "qty-1", itemNumber: 1, name: "Drywall", quantity: 2400, unit: "SF", category: "Finishes" },
      { id: "qty-2", itemNumber: 2, name: "Baseboard", quantity: 580, unit: "LF", category: "Millwork" },
      { id: "qty-3", itemNumber: 3, name: "Doors", quantity: 14, unit: "EA", category: "Openings" },
      { id: "qty-4", itemNumber: 4, name: "Windows", quantity: 10, unit: "EA", category: "Openings" },
      { id: "qty-5", itemNumber: 5, name: "Flooring", quantity: 1850, unit: "SF", category: "Finishes" },
      { id: "qty-6", itemNumber: 6, name: "Concrete", quantity: 18, unit: "CY", category: "Substructure" },
    ],
    estimateItems: [
      {
        id: "est-1",
        quantityId: "qty-1",
        csiCode: "09 29 00",
        name: "09 29 00 - Gypsum Board (Drywall)",
        quantity: 2400,
        unit: "SF",
        materialCost: 3600.0,
        laborCost: 2880.0,
        equipmentCost: 240.0,
        directCost: 6720.0,
      },
      {
        id: "est-2",
        quantityId: "qty-2",
        csiCode: "06 11 00",
        name: "06 11 00 - Wood Framing",
        quantity: 1200,
        unit: "LF",
        materialCost: 2100.0,
        laborCost: 1880.0,
        equipmentCost: 200.0,
        directCost: 4180.0,
      },
      {
        id: "est-3",
        quantityId: "qty-5",
        csiCode: "09 91 00",
        name: "09 91 00 - Interior Painting",
        quantity: 1850,
        unit: "SF",
        materialCost: 450.0,
        laborCost: 500.0,
        equipmentCost: 50.0,
        directCost: 1000.0,
      },
    ],
  },
  {
    id: "proj-2",
    name: "Kitchen Remodel",
    clientName: "David & Sarah Miller",
    address: "890 Oak Ave",
    projectType: "Kitchen Remodel",
    status: "In Progress",
    updatedAt: "Updated yesterday",
    overheadPercentage: 12,
    markupPercentage: 20,
    revisions: [
      {
        id: "rev-2-1",
        revisionNumber: "01",
        fileName: "Kitchen_Layout_Plans.pdf",
        fileSize: "12.1 MB",
        pages: 14,
        uploadDate: "Aug 29, 2026",
        uploadedBy: "J. Smith",
        isCurrent: true,
      },
    ],
    quantities: [
      { id: "qty-2-1", itemNumber: 1, name: "Custom Cabinets", quantity: 32, unit: "LF", category: "Millwork" },
      { id: "qty-2-2", itemNumber: 2, name: "Quartz Countertops", quantity: 65, unit: "SF", category: "Finishes" },
      { id: "qty-2-3", itemNumber: 3, name: "Tile Backsplash", quantity: 48, unit: "SF", category: "Finishes" },
      { id: "qty-2-4", itemNumber: 4, name: "Plumbing Fixtures", quantity: 3, unit: "EA", category: "Plumbing" },
      { id: "qty-2-5", itemNumber: 5, name: "Recessed Lighting", quantity: 12, unit: "EA", category: "Electrical" },
    ],
    estimateItems: [
      {
        id: "est-2-1",
        csiCode: "12 35 30",
        name: "12 35 30 - Residential Custom Cabinetry",
        quantity: 32,
        unit: "LF",
        materialCost: 14200,
        laborCost: 4800,
        equipmentCost: 400,
        directCost: 19400,
      },
      {
        id: "est-2-2",
        csiCode: "12 36 61",
        name: "12 36 61 - Quartz Countertops & Island Slab",
        quantity: 65,
        unit: "SF",
        materialCost: 5850,
        laborCost: 2100,
        equipmentCost: 250,
        directCost: 8200,
      },
      {
        id: "est-2-3",
        csiCode: "09 30 13",
        name: "09 30 13 - Ceramic Tile Backsplash",
        quantity: 48,
        unit: "SF",
        materialCost: 1200,
        laborCost: 1600,
        equipmentCost: 150,
        directCost: 2950,
      },
      {
        id: "est-2-4",
        csiCode: "22 40 00",
        name: "22 40 00 - Plumbing Fixtures & Rough-In",
        quantity: 3,
        unit: "EA",
        materialCost: 1800,
        laborCost: 1650,
        equipmentCost: 150,
        directCost: 3600,
      },
    ],
  },
  {
    id: "proj-3",
    name: "Bathroom Addition",
    clientName: "Robert Taylor",
    address: "45 Pine Blvd",
    projectType: "Bathroom Addition",
    status: "Planning",
    updatedAt: "Updated 3d ago",
    overheadPercentage: 12,
    markupPercentage: 20,
    revisions: [
      {
        id: "rev-3-1",
        revisionNumber: "01",
        fileName: "Master_Bath_Schematic.pdf",
        fileSize: "8.5 MB",
        pages: 6,
        uploadDate: "Aug 20, 2026",
        uploadedBy: "J. Smith",
        isCurrent: true,
      },
    ],
    quantities: [
      { id: "qty-3-1", itemNumber: 1, name: "Framing & Partitions", quantity: 320, unit: "LF", category: "Framing" },
      { id: "qty-3-2", itemNumber: 2, name: "Cement Board", quantity: 240, unit: "SF", category: "Finishes" },
    ],
    estimateItems: [],
  },
  {
    id: "proj-4",
    name: "New Construction",
    clientName: "Highland Peak Developers",
    address: "Lot 42, Vista Heights",
    projectType: "New Construction",
    status: "In Progress",
    updatedAt: "Updated 5h ago",
    overheadPercentage: 12,
    markupPercentage: 20,
    revisions: [
      {
        id: "rev-4-1",
        revisionNumber: "01",
        fileName: "Vista_Heights_Full_Set.pdf",
        fileSize: "45.2 MB",
        pages: 58,
        uploadDate: "Jul 10, 2026",
        uploadedBy: "J. Smith",
        isCurrent: true,
      },
    ],
    quantities: [
      { id: "qty-4-1", itemNumber: 1, name: "Foundation & Footings", quantity: 180, unit: "CY", category: "Substructure" },
      { id: "qty-4-2", itemNumber: 2, name: "Structural Framing", quantity: 4200, unit: "SF", category: "Framing" },
      { id: "qty-4-3", itemNumber: 3, name: "Roof Trusses & Sheathing", quantity: 3800, unit: "SF", category: "Roofing" },
    ],
    estimateItems: [
      {
        id: "est-4-1",
        csiCode: "03 30 00",
        name: "03 30 00 - Cast-in-Place Concrete",
        quantity: 180,
        unit: "CY",
        materialCost: 125000,
        laborCost: 78000,
        equipmentCost: 22000,
        directCost: 225000,
      },
      {
        id: "est-4-2",
        csiCode: "06 10 00",
        name: "06 10 00 - Rough Carpentry & Framing",
        quantity: 4200,
        unit: "SF",
        materialCost: 210000,
        laborCost: 155000,
        equipmentCost: 18000,
        directCost: 383000,
      },
      {
        id: "est-4-3",
        csiCode: "07 31 00",
        name: "07 31 00 - Shingle Roofing System",
        quantity: 3800,
        unit: "SF",
        materialCost: 42000,
        laborCost: 32000,
        equipmentCost: 6000,
        directCost: 80000,
      },
    ],
  },
];

export const INITIAL_MATERIALS: MaterialItem[] = [
  { id: "mat-1", name: "1/2\" Standard Gypsum Drywall Board", category: "Drywall", unit: "SF", unitPrice: 1.5, lastUpdated: "Sep 1, 2026" },
  { id: "mat-2", name: "5/8\" Type X Fire-Rated Drywall", category: "Drywall", unit: "SF", unitPrice: 1.85, lastUpdated: "Sep 1, 2026" },
  { id: "mat-3", name: "2x4x8' Kiln-Dried Studs", category: "Lumber", unit: "LF", unitPrice: 4.25, lastUpdated: "Sep 1, 2026" },
  { id: "mat-4", name: "2x6x16' Pressure Treated Joists", category: "Lumber", unit: "LF", unitPrice: 6.8, lastUpdated: "Sep 1, 2026" },
  { id: "mat-5", name: "3000 PSI Ready-Mix Concrete", category: "Concrete", unit: "CY", unitPrice: 145.0, lastUpdated: "Sep 1, 2026" },
  { id: "mat-6", name: "3-1/4\" Primed Pine Baseboard", category: "Millwork", unit: "LF", unitPrice: 2.15, lastUpdated: "Sep 1, 2026" },
  { id: "mat-7", name: "Engineered Hardwood Flooring", category: "Flooring", unit: "SF", unitPrice: 5.5, lastUpdated: "Sep 1, 2026" },
  { id: "mat-8", name: "Exterior Composite Decking", category: "Decking", unit: "SF", unitPrice: 8.75, lastUpdated: "Sep 1, 2026" },
];

export const INITIAL_ASSEMBLIES: AssemblyItem[] = [
  {
    id: "asm-1",
    name: "Standard Drywall Partition Assembly",
    category: "Finishes",
    description: "1/2\" Drywall both sides, taped, mudded, sanded to Level 4 finish",
    unit: "SF",
    materialCostPerUnit: 1.5,
    laborCostPerUnit: 1.2,
    equipmentCostPerUnit: 0.1,
  },
  {
    id: "asm-2",
    name: "2x4 Wood Stud Wall Framing Assembly",
    category: "Carpentry",
    description: "2x4 studs @ 16\" OC, top and bottom plates, blocking and fasteners",
    unit: "LF",
    materialCostPerUnit: 1.75,
    laborCostPerUnit: 1.55,
    equipmentCostPerUnit: 0.15,
  },
  {
    id: "asm-3",
    name: "Concrete Footing & Pier Assembly",
    category: "Foundation",
    description: "Excavation, formwork, rebar cage, 3000 PSI pour and finish",
    unit: "CY",
    materialCostPerUnit: 160.0,
    laborCostPerUnit: 95.0,
    equipmentCostPerUnit: 25.0,
  },
];

export const INITIAL_PRICELISTS: PriceList[] = [
  { id: "pl-1", name: "West Coast Regional Construction Guide", region: "Pacific NW / CA", trade: "General Commercial & Residential", effectiveDate: "Q3 2026", itemCount: 1420 },
  { id: "pl-2", name: "RoughBid Contractor Rates", region: "National Average", trade: "Residential Remodel & Additions", effectiveDate: "2026 Standard", itemCount: 850 },
  { id: "pl-3", name: "Lumber & Engineered Wood Feed", region: "North America", trade: "Framing & Structural", effectiveDate: "Weekly Auto-Sync", itemCount: 320 },
];

function normalizeUserProfile(user: UserProfile): UserProfile {
  const plan = /prime bid|class pass/i.test(user.plan) ? "RoughBid SaaS" : user.plan;
  const company = /prime bid/i.test(user.company) ? "KSP Ventures" : user.company;
  return { ...user, plan, company };
}

// Local Storage Helper
export const StorageService = {
  getProjects(): Project[] {
    try {
      const data = localStorage.getItem(STORAGE_KEY_PROJECTS);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  },

  scopedProjectsKey(scope: string): string {
    return `${STORAGE_KEY_PROJECT_SCOPE_PREFIX}:${scope}`;
  },

  getProjectsForScope(scope: string): Project[] {
    try {
      const data = localStorage.getItem(this.scopedProjectsKey(scope));
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  },

  saveProjectsForScope(scope: string, projects: Project[]): void {
    try {
      localStorage.setItem(this.scopedProjectsKey(scope), JSON.stringify(projects));
    } catch (e) {
      console.error("Failed to save scoped projects to localStorage", e);
    }
  },

  saveProjects(projects: Project[]): void {
    try {
      localStorage.setItem(STORAGE_KEY_PROJECTS, JSON.stringify(projects));
    } catch (e) {
      console.error("Failed to save projects to localStorage", e);
    }
  },

  getProjectById(id: string): Project | null {
    const projects = this.getProjects();
    return projects.find((p) => p.id === id) || null;
  },

  saveProject(project: Project): void {
    const projects = this.getProjects();
    const index = projects.findIndex((p) => p.id === project.id);
    if (index >= 0) {
      projects[index] = { ...project, updatedAt: "Just now" };
    } else {
      projects.unshift({ ...project, updatedAt: "Just now" });
    }
    this.saveProjects(projects);
  },

  deleteProject(id: string): void {
    const projects = this.getProjects().filter((p) => p.id !== id);
    this.saveProjects(projects);
  },

  getMaterials(): MaterialItem[] {
    try {
      const data = localStorage.getItem(STORAGE_KEY_MATERIALS);
      if (!data) {
        localStorage.setItem(STORAGE_KEY_MATERIALS, JSON.stringify(INITIAL_MATERIALS));
        return INITIAL_MATERIALS;
      }
      return JSON.parse(data);
    } catch {
      return INITIAL_MATERIALS;
    }
  },

  saveMaterials(materials: MaterialItem[]): void {
    localStorage.setItem(STORAGE_KEY_MATERIALS, JSON.stringify(materials));
  },

  getAssemblies(): AssemblyItem[] {
    try {
      const data = localStorage.getItem(STORAGE_KEY_ASSEMBLIES);
      if (!data) {
        localStorage.setItem(STORAGE_KEY_ASSEMBLIES, JSON.stringify(INITIAL_ASSEMBLIES));
        return INITIAL_ASSEMBLIES;
      }
      return JSON.parse(data);
    } catch {
      return INITIAL_ASSEMBLIES;
    }
  },

  saveAssemblies(assemblies: AssemblyItem[]): void {
    localStorage.setItem(STORAGE_KEY_ASSEMBLIES, JSON.stringify(assemblies));
  },

  getPriceLists(): PriceList[] {
    try {
      const data = localStorage.getItem(STORAGE_KEY_PRICELISTS);
      if (!data) {
        localStorage.setItem(STORAGE_KEY_PRICELISTS, JSON.stringify(INITIAL_PRICELISTS));
        return INITIAL_PRICELISTS;
      }
      return JSON.parse(data);
    } catch {
      return INITIAL_PRICELISTS;
    }
  },

  getUser(): UserProfile {
    try {
      const data = localStorage.getItem(STORAGE_KEY_USER);
      if (!data) {
        localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(INITIAL_USER));
        return INITIAL_USER;
      }
      const normalized = normalizeUserProfile(JSON.parse(data));
      localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(normalized));
      return normalized;
    } catch {
      return INITIAL_USER;
    }
  },

  getUserProfile(): UserProfile {
    return this.getUser();
  },

  saveUser(user: UserProfile): void {
    localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(user));
  },

  saveUserProfile(user: UserProfile): void {
    this.saveUser(user);
  },
};
