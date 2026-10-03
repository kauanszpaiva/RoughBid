import React from 'react';
import { ESTIMATE_SERVICES } from '../utils/estimateIntake';

export function EstimateServicePicker({ selected, onChange, disabled = false }: {
  selected: string[]; onChange: (services: string[]) => void; disabled?: boolean;
}) {
  return <fieldset disabled={disabled} className="space-y-2">
    <legend className="mb-2 text-sm font-semibold text-slate-900">Choose your service</legend>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {ESTIMATE_SERVICES.map(service => <label key={service.id} className={`flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm ${selected.includes(service.id) ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 bg-white text-slate-700'}`}>
        <input type="checkbox" checked={selected.includes(service.id)} onChange={event => onChange(event.target.checked ? [...selected, service.id] : selected.filter(id => id !== service.id))} />
        {service.label}
      </label>)}
    </div>
    <p className="text-xs text-slate-500">Select one or more services for the same project.</p>
  </fieldset>;
}
