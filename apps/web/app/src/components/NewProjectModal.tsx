import React, { useState } from "react";
import { X, Upload, Loader2 } from "lucide-react";
import type { Project } from "../types";
import { EstimateServicePicker } from "./EstimateServicePicker";
import { ESTIMATE_FILE_ACCEPT, estimateServiceScope, splitEstimateFiles } from "../utils/estimateIntake";

interface NewProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (project: Project, files?: File[]) => Promise<void>;
  initialProjectType?: string;
  defaultOverhead?: number;
  defaultMarkup?: number;
}

export const NewProjectModal: React.FC<NewProjectModalProps> = ({
  isOpen, onClose, onCreate, initialProjectType = "Construction Project",
  defaultOverhead = 12, defaultMarkup = 20,
}) => {
  const [files, setFiles] = useState<File[]>([]);
  const [services, setServices] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [clientName, setClientName] = useState("");
  const [address, setAddress] = useState("");
  const [jurisdictionState, setJurisdictionState] = useState<Project["jurisdictionState"]>();
  const [municipality, setMunicipality] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [permitDate, setPermitDate] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [newId] = useState(() => `proj-${crypto.randomUUID()}`);

  if (!isOpen) return null;
  const selectFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const incoming = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!incoming.length) return;
    try {
      const next = [...files, ...incoming];
      splitEstimateFiles(next);
      setFiles(next); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Check your files."); }
  };
  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    try {
      splitEstimateFiles(files);
      const selected = estimateServiceScope(services);
      if (![defaultOverhead, defaultMarkup].every(value => Number.isFinite(value) && value >= 0 && value <= 100)) {
        throw new Error("Check your default overhead and markup in Settings.");
      }
      const project: Project = {
        id: newId, intakeMode: "quick", selectedServices: services,
        name: (name.trim() || files[0]!.name.replace(/\.[^.]+$/, "") || "New estimate").slice(0, 160),
        clientName: clientName.trim(), address: address.trim(),
        projectType: selected.scope || initialProjectType,
        ...(jurisdictionState ? { jurisdictionState } : {}),
        ...(municipality.trim() ? { municipality: municipality.trim() } : {}),
        ...(postalCode.trim() ? { postalCode: postalCode.trim() } : {}),
        ...(permitDate ? { permitDate } : {}),
        status: "Planning", updatedAt: "Just now",
        overheadPercentage: defaultOverhead, markupPercentage: defaultMarkup,
        revisions: [], quantities: [], estimateItems: [],
      };
      setSaving(true); setError("");
      await onCreate(project, files);
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Your estimate could not be saved. Try again."); }
    finally { setSaving(false); }
  };

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-2 backdrop-blur-2xs sm:p-4">
    <div role="dialog" aria-modal="true" aria-labelledby="new-project-title" className="flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
        <div><h3 id="new-project-title" className="font-bold text-slate-900">Start an estimate</h3>
          <p className="mt-1 text-xs text-slate-500">Photos, plans, or both. Choose the work you want priced.</p></div>
        <button type="button" onClick={onClose} disabled={saving} aria-label="Close new estimate" className="rounded-md p-2 text-slate-500"><X className="h-5 w-5" /></button>
      </div>
      <form onSubmit={handleSubmit} className="space-y-5 overflow-y-auto p-5">
        {error && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
        <fieldset disabled={saving} className="space-y-3">
          <legend className="mb-2 text-sm font-semibold">1. Add photos and/or plans</legend>
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-6 text-center">
            <Upload className="h-6 w-6 text-brand-500" /><span className="text-sm font-semibold">Choose files</span>
            <span className="text-xs text-slate-500">PDF, JPEG, PNG or WebP</span>
            <input aria-label="Add estimate photos and plans" type="file" accept={ESTIMATE_FILE_ACCEPT} multiple onChange={selectFiles} className="mt-2 max-w-full text-xs" />
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-brand-700">
            Take a photo<input aria-label="Take an estimate photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={selectFiles} className="max-w-48 text-xs" />
          </label>
          {files.length > 0 && <ul className="space-y-2 text-sm">{files.map((file, index) => <li key={index} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 p-2">
            <span className="min-w-0 break-words">{file.name}</span>
            <button type="button" aria-label={`Remove ${file.name}`} onClick={() => setFiles(current => current.filter((_, position) => position !== index))} className="shrink-0 p-1"><X className="h-4 w-4" /></button>
          </li>)}</ul>}
        </fieldset>
        <div><p className="mb-2 text-xs font-semibold text-brand-600">2. Select the work</p><EstimateServicePicker selected={services} onChange={setServices} disabled={saving} /></div>
        <details className="rounded-lg border border-slate-200 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-600">Project and pricing details (optional)</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs">Project name<input aria-label="Project name" value={name} onChange={event => setName(event.target.value)} disabled={saving} maxLength={160} className="mt-1 block w-full rounded border p-2" placeholder="Use the file name" /></label>
            <label className="text-xs">Client name<input value={clientName} onChange={event => setClientName(event.target.value)} disabled={saving} maxLength={160} className="mt-1 block w-full rounded border p-2" /></label>
            <label className="text-xs sm:col-span-2">Project address<input value={address} onChange={event => setAddress(event.target.value)} disabled={saving} maxLength={500} className="mt-1 block w-full rounded border p-2" /></label>
            <label className="text-xs">State<select value={jurisdictionState ?? ""} onChange={event => setJurisdictionState((event.target.value || undefined) as Project["jurisdictionState"])} disabled={saving} className="mt-1 block w-full rounded border p-2"><option value="">Confirm later</option>{["CT", "MA", "ME", "NH", "RI", "VT"].map(state => <option key={state}>{state}</option>)}</select></label>
            <label className="text-xs">Municipality<input value={municipality} onChange={event => setMunicipality(event.target.value)} disabled={saving} className="mt-1 block w-full rounded border p-2" /></label>
            <label className="text-xs">ZIP code<input value={postalCode} onChange={event => setPostalCode(event.target.value)} disabled={saving} inputMode="numeric" pattern="[0-9]{5}(-[0-9]{4})?" className="mt-1 block w-full rounded border p-2" /></label>
            <label className="text-xs">Pricing date<input type="date" value={permitDate} onChange={event => setPermitDate(event.target.value)} disabled={saving} className="mt-1 block w-full rounded border p-2" /></label>
          </div>
          <p className="mt-3 text-xs text-slate-500">Confirm the actual location before using regional prices. Your saved overhead and markup apply.</p>
        </details>
        <button type="submit" disabled={saving || !files.length || !services.length} aria-busy={saving} className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-500 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}{saving ? "Saving estimate…" : "Upload and continue"}
        </button>
      </form>
    </div>
  </div>;
};
