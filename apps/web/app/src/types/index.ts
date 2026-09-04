export type ProjectStatus = "Planning" | "In Progress" | "Completed";

export type UnitType = "SF" | "LF" | "EA" | "CY" | "SY" | "HR" | "LS";

export interface PlanRevision {
  id: string;
  revisionNumber: string; // e.g., "01", "02", "03"
  fileName: string;
  fileSize: string; // e.g. "18.4 MB"
  pages: number;
  uploadDate: string;
  uploadedBy: string;
  isCurrent: boolean;
  notes?: string;
  fileUrl?: string; // object URL or base64
}

export interface QuantityItem {
  id: string;
  itemNumber: number;
  name: string;
  category?: string;
  quantity: number;
  unit: UnitType;
}

export interface EstimateItem {
  id: string;
  quantityId?: string;
  csiCode?: string; // e.g. "09 29 00"
  name: string;
  quantity: number;
  unit: UnitType;
  materialCost: number; // total material for line item
  laborCost: number;    // total labor for line item
  equipmentCost: number;// total equipment/other
  directCost: number;   // material + labor + equipment (computed)
}

export interface FinancialCalculation {
  directCost: number;
  overheadPercentage: number;
  overheadAmount: number;
  costBeforeMarkup: number;
  markupPercentage: number;
  markupAmount: number;
  finalPrice: number;
  marginPercentage: number;
}

export interface Project {
  id: string;
  name: string;
  clientName: string;
  address: string;
  projectType: string;
  status: ProjectStatus;
  updatedAt: string;
  overheadPercentage: number; // e.g. 12
  markupPercentage: number;   // e.g. 20
  revisions: PlanRevision[];
  quantities: QuantityItem[];
  estimateItems: EstimateItem[];
  notes?: string;
}

export interface MaterialItem {
  id: string;
  name: string;
  category: string;
  unit: UnitType;
  unitPrice?: number;
  unitCost?: number;
  supplier?: string;
  lastUpdated: string;
}

export interface AssemblyItem {
  id: string;
  name: string;
  category: string;
  description: string;
  unit: UnitType;
  materialCostPerUnit: number;
  laborCostPerUnit: number;
  equipmentCostPerUnit: number;
}

export interface PriceList {
  id: string;
  name: string;
  region: string;
  trade: string;
  effectiveDate: string;
  itemCount: number;
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: string;
  plan: string;
  company: string;
  licenseNumber?: string;
  defaultOverhead: number;
  defaultMarkup: number;
}

