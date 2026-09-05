import React, { useState } from "react";
import { X, Plus, Upload, Building2, MapPin, User } from "lucide-react";
import { Project, PlanRevision } from "../types";

interface NewProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (project: Project) => void;
}

export const NewProjectModal: React.FC<NewProjectModalProps> = ({
  isOpen,
  onClose,
  onCreate,
}) => {
  const [name, setName] = useState<string>("");
  const [clientName, setClientName] = useState<string>("");
  const [address, setAddress] = useState<string>("");
  const [projectType, setProjectType] = useState<string>("Deck Renovation");
  const [overheadPct, setOverheadPct] = useState<number>(12);
  const [markupPct, setMarkupPct] = useState<number>(20);
  const [planFile, setPlanFile] = useState<File | null>(null);
  const [error, setError] = useState<string>("");

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Project name is required.");
      return;
    }
    if (!clientName.trim()) {
      setError("Client name is required.");
      return;
    }
    if (!address.trim()) {
      setError("Project address is required.");
      return;
    }

    const newId = `proj-${Date.now()}`;
    const initialRevision: PlanRevision | null = planFile
      ? {
          id: `rev-${Date.now()}`,
          revisionNumber: "01",
          fileName: planFile.name,
          fileSize: `${(planFile.size / (1024 * 1024)).toFixed(1)} MB`,
          pages: 0,
          uploadDate: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
          uploadedBy: clientName,
          isCurrent: true,
          notes: "Uploaded plan file. Page count and AI takeoff require processing.",
        }
      : null;

    const newProject: Project = {
      id: newId,
      name: name.trim(),
      clientName: clientName.trim(),
      address: address.trim(),
      projectType,
      status: initialRevision ? "In Progress" : "Planning",
      updatedAt: "Just now",
      overheadPercentage: overheadPct,
      markupPercentage: markupPct,
      revisions: initialRevision ? [initialRevision] : [],
      quantities: [],
      estimateItems: [],
    };

    onCreate(newProject);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-2xs p-2 sm:p-4 select-none animate-in fade-in duration-150">
      <div className="bg-white rounded-xl shadow-xl border border-[#e5e7eb] w-full max-w-lg overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-4 py-3 sm:px-6 sm:py-4 border-b border-[#e5e7eb] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#2563eb] flex items-center justify-center text-white font-bold text-xs shrink-0">
              <Plus className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-[#111827]">Create New Project</h3>
              <p className="text-[11px] sm:text-xs text-[#6b7280]">Start with project details, then upload plans and confirm quantities</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-[#9ca3af] hover:text-[#111827] rounded-md transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-4 sm:p-6 space-y-3.5 sm:space-y-4 overflow-y-auto flex-1">
          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-md font-medium">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-bold text-[#374151] mb-1">
              Project Name *
            </label>
            <div className="relative">
              <input
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError("");
                }}
                placeholder="e.g., Smith Residence — Deck Renovation"
                className="w-full px-3 py-2 pl-9 border border-[#e5e7eb] rounded-lg text-xs text-[#111827] focus:outline-hidden focus:ring-2 focus:ring-[#2563eb]"
                required
              />
              <Building2 className="w-4 h-4 text-[#9ca3af] absolute left-3 top-2.5" />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-[#374151] mb-1">
                Client Name *
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  placeholder="e.g., J. Smith"
                  className="w-full px-3 py-2 pl-9 border border-[#e5e7eb] rounded-lg text-xs text-[#111827] focus:outline-hidden focus:ring-2 focus:ring-[#2563eb]"
                  required
                />
                <User className="w-4 h-4 text-[#9ca3af] absolute left-3 top-2.5" />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-[#374151] mb-1">
                Project Type
              </label>
              <select
                value={projectType}
                onChange={(e) => setProjectType(e.target.value)}
                className="w-full px-3 py-2 border border-[#e5e7eb] rounded-lg text-xs text-[#111827] bg-white focus:outline-hidden focus:ring-2 focus:ring-[#2563eb]"
              >
                <option value="Deck Renovation">Deck Renovation</option>
                <option value="Kitchen Remodel">Kitchen Remodel</option>
                <option value="Bathroom Addition">Bathroom Addition</option>
                <option value="New Construction">New Construction</option>
                <option value="Commercial Tenant Improvement">Commercial TI</option>
                <option value="Custom Residential">Custom Residential</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-[#374151] mb-1">
              Project Address *
            </label>
            <div className="relative">
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="e.g., 124 Maple Street, Springfield"
                className="w-full px-3 py-2 pl-9 border border-[#e5e7eb] rounded-lg text-xs text-[#111827] focus:outline-hidden focus:ring-2 focus:ring-[#2563eb]"
                required
              />
              <MapPin className="w-4 h-4 text-[#9ca3af] absolute left-3 top-2.5" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#6b7280] mb-1">
                Default Overhead (%)
              </label>
              <input
                type="number"
                min="0"
                max="100"
                step="0.5"
                value={overheadPct}
                onChange={(e) => setOverheadPct(Number(e.target.value))}
                className="w-full px-3 py-1.5 border border-[#e5e7eb] rounded-lg text-xs text-[#111827] font-semibold"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6b7280] mb-1">
                Default Markup (%)
              </label>
              <input
                type="number"
                min="0"
                max="100"
                step="0.5"
                value={markupPct}
                onChange={(e) => setMarkupPct(Number(e.target.value))}
                className="w-full px-3 py-1.5 border border-[#e5e7eb] rounded-lg text-xs text-[#111827] font-semibold"
              />
            </div>
          </div>

          {/* Plan PDF File Selection */}
          <div>
            <label className="block text-xs font-bold text-[#374151] mb-1">
              Initial Plan PDF (Optional)
            </label>
            <label className="border-2 border-dashed border-[#e5e7eb] rounded-lg p-3.5 flex items-center justify-center gap-2.5 cursor-pointer hover:border-[#2563eb] hover:bg-[#eff6ff] transition text-center">
              <Upload className="w-4 h-4 text-[#2563eb] shrink-0" />
              <span className="text-xs text-[#6b7280] font-medium truncate">
                {planFile ? planFile.name : "Select a PDF or image plan to start takeoff"}
              </span>
              <input
                type="file"
                accept=".pdf,image/*"
                onChange={(e) => {
                  if (e.target.files?.[0]) {
                    setPlanFile(e.target.files[0]);
                  }
                }}
                className="hidden"
              />
            </label>
          </div>

          {/* Actions */}
          <div className="pt-2 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-[#4b5563] hover:text-[#111827] hover:bg-[#f3f4f6] rounded-md transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2 bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-md text-xs font-semibold transition shadow-xs flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Create Project</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
