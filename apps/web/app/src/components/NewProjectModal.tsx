import React, { useState } from "react";
import { X, Plus, Building2, MapPin, User } from "lucide-react";
import { Project } from "../types";

interface NewProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (project: Project) => Promise<void>;
  initialProjectType?: string;
  defaultOverhead?: number;
  defaultMarkup?: number;
}

export const NewProjectModal: React.FC<NewProjectModalProps> = ({
  isOpen,
  onClose,
  onCreate,
  initialProjectType = "Deck Renovation",
  defaultOverhead = 12,
  defaultMarkup = 20,
}) => {
  const [name, setName] = useState<string>("");
  const [clientName, setClientName] = useState<string>("");
  const [address, setAddress] = useState<string>("");
  const [projectType, setProjectType] = useState<string>(initialProjectType);
  const [jurisdictionState, setJurisdictionState] = useState<Project["jurisdictionState"]>("MA");
  const [municipality, setMunicipality] = useState<string>("");
  const [postalCode, setPostalCode] = useState<string>("");
  const [permitDate, setPermitDate] = useState<string>("");
  const [overheadPct, setOverheadPct] = useState<number>(defaultOverhead);
  const [markupPct, setMarkupPct] = useState<number>(defaultMarkup);
  const [error, setError] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [newId] = useState(() => `proj-${crypto.randomUUID()}`);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
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
    if (!jurisdictionState || !municipality.trim() || !/^\d{5}(?:-\d{4})?$/.test(postalCode.trim()) || !permitDate) {
      setError("State, municipality, valid ZIP code, and permit or pricing date are required.");
      return;
    }

    if (![overheadPct, markupPct].every((value) => Number.isFinite(value) && value >= 0 && value <= 100)) {
      setError("Overhead and markup must be between 0 and 100%.");
      return;
    }

    const newProject: Project = {
      id: newId,
      name: name.trim(),
      clientName: clientName.trim(),
      address: address.trim(),
      projectType,
      jurisdictionState,
      municipality: municipality.trim(),
      postalCode: postalCode.trim(),
      permitDate,
      status: "Planning",
      updatedAt: "Just now",
      overheadPercentage: overheadPct,
      markupPercentage: markupPct,
      revisions: [],
      quantities: [],
      estimateItems: [],
    };

    setSaving(true);
    setError("");
    try {
      await onCreate(newProject);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Your project could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-2xs p-2 sm:p-4 select-none animate-in fade-in duration-150">
      <div role="dialog" aria-modal="true" aria-labelledby="new-project-title" className="bg-white rounded-xl shadow-xl border border-[#e5e7eb] w-full max-w-lg overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-4 py-3 sm:px-6 sm:py-4 border-b border-[#e5e7eb] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#2563eb] flex items-center justify-center text-white font-bold text-xs shrink-0">
              <Plus className="w-4 h-4" />
            </div>
            <div>
              <h3 id="new-project-title" className="text-sm font-bold text-[#111827]">Create New Project</h3>
              <p className="text-[11px] sm:text-xs text-[#6b7280]">Start with project details, then upload plans and confirm quantities</p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            aria-label="Close new project"
            className="p-1.5 text-[#9ca3af] hover:text-[#111827] rounded-md transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-4 sm:p-6 space-y-3.5 sm:space-y-4 overflow-y-auto flex-1">
          {error && (
            <div role="alert" className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-md font-medium">
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

          <fieldset className="rounded-lg border border-[#e5e7eb] p-3">
            <legend className="px-1 text-xs font-bold text-[#374151]">New England jurisdiction *</legend>
            <p className="mb-3 text-[11px] leading-relaxed text-[#6b7280]">Used to select dated local requirements and regional pricing sources. Confirm with the permitting authority before release.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-[#6b7280]" htmlFor="jurisdiction-state">State</label>
                <select id="jurisdiction-state" value={jurisdictionState} onChange={(event) => setJurisdictionState(event.target.value as Project["jurisdictionState"])} className="w-full rounded-lg border border-[#e5e7eb] bg-white px-3 py-2 text-xs" required>
                  <option value="CT">Connecticut</option><option value="MA">Massachusetts</option><option value="ME">Maine</option>
                  <option value="NH">New Hampshire</option><option value="RI">Rhode Island</option><option value="VT">Vermont</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-[#6b7280]" htmlFor="municipality">Municipality</label>
                <input id="municipality" value={municipality} onChange={(event) => setMunicipality(event.target.value)} className="w-full rounded-lg border border-[#e5e7eb] px-3 py-2 text-xs" placeholder="e.g., Boston" required />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-[#6b7280]" htmlFor="postal-code">ZIP code</label>
                <input id="postal-code" value={postalCode} onChange={(event) => setPostalCode(event.target.value)} className="w-full rounded-lg border border-[#e5e7eb] px-3 py-2 text-xs" inputMode="numeric" pattern="[0-9]{5}(-[0-9]{4})?" placeholder="02108" required />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-[#6b7280]" htmlFor="permit-date">Permit or pricing date</label>
                <input id="permit-date" type="date" value={permitDate} onChange={(event) => setPermitDate(event.target.value)} className="w-full rounded-lg border border-[#e5e7eb] px-3 py-2 text-xs" required />
              </div>
            </div>
          </fieldset>

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

          <p className="rounded-lg bg-blue-50 p-3 text-xs leading-relaxed text-blue-800">
            After creating your project, upload your PDF in Plans. Your project starts with no drawings, quantities, or prices.
          </p>
          {/* Actions */}
          <div className="pt-2 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-xs font-medium text-[#4b5563] hover:text-[#111827] hover:bg-[#f3f4f6] rounded-md transition"
            >
              Cancel
            </button>
            <button
              type="submit" disabled={saving} aria-busy={saving}
              className="px-5 py-2 bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-md text-xs font-semibold transition shadow-xs flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>{saving ? "Creating project…" : "Create Project"}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
