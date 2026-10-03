import React, { useState } from 'react';
import type { PhotoObservation, PhotoSourceAsset } from '../services/photos-api';
import { emptyPhotoPlanarDraft, type PhotoPlanarDraft } from '../utils/photoReview';
import { planPointFromPointer } from '../utils/planMeasurementReview';

export const PhotoPlanarReview = ({ observation, assets, draft, previews, onPreview, onChange, disabled }: {
  observation: PhotoObservation; assets: readonly PhotoSourceAsset[]; draft: PhotoPlanarDraft | undefined;
  previews: Record<string, string>; onPreview: (assetId: string) => void; onChange: (draft: PhotoPlanarDraft) => void; disabled: boolean;
}) => {
  const [capture, setCapture] = useState<'reference' | 'measurement' | null>(null);
  const current = draft ?? emptyPhotoPlanarDraft(observation, assets);
  const source = assets.find(asset => asset.id === current.sourceAssetId), preview = previews[current.sourceAssetId];
  const update = (patch: Partial<PhotoPlanarDraft>, reset = true) => onChange({ ...current,
    ...(reset ? { rectangleVerified: false, lensDistortionReviewed: false, samePlaneReviewed: false, geometryReviewed: false } : {}), ...patch });
  const mark = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || !capture || !preview) return;
    const point = planPointFromPointer(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
    if (!point) return;
    if (capture === 'reference') {
      const next = [...current.referencePoints, point].slice(0, 4);
      update({ referencePoints: next, measurementPoints: [] }); if (next.length === 4) setCapture(null);
    } else if (current.measurementPoints.length < 64) update({ measurementPoints: [...current.measurementPoints, point] });
  };
  return <div aria-label={`Four-point photo measurement for ${observation.label}`} className="rounded border border-blue-200 bg-blue-50 p-3 space-y-3">
    <p>Use a real rectangle with two known dimensions on the same flat surface. Mark its corners in order: top left, top right, bottom right, bottom left. The server checks perspective and calculates the reviewed region; no quantity is copied from a model.</p>
    {observation.regions.length > 1 && <label className="block">Calibration source<select disabled={disabled} className="ml-2 rounded border p-1" value={observation.regions.findIndex(region => region.sourceAssetId === current.sourceAssetId && region.surfaceKey === current.surfaceKey)} onChange={event => { setCapture(null); onChange(emptyPhotoPlanarDraft(observation, assets, Number(event.target.value))); }}>{observation.regions.map((region, index) => <option key={index} value={index}>Photo {assets.findIndex(asset => asset.id === region.sourceAssetId) + 1}, surface {index + 1}</option>)}</select></label>}
    <div className="flex flex-wrap gap-2">
      <label>Known reference width<input disabled={disabled} aria-label="Known reference width" inputMode="decimal" className="block rounded border p-1 w-32" value={current.referenceWidth} onChange={event => update({ referenceWidth: event.target.value })} /></label>
      <label>Known reference height<input disabled={disabled} aria-label="Known reference height" inputMode="decimal" className="block rounded border p-1 w-32" value={current.referenceHeight} onChange={event => update({ referenceHeight: event.target.value })} /></label>
      <label>Reference unit<select disabled={disabled} aria-label="Reference unit" className="block rounded border p-1" value={current.referenceUnit} onChange={event => update({ referenceUnit: event.target.value as 'M' | 'LF' })}><option value="M">Metres</option><option value="LF">Feet</option></select></label>
      <label>Measure<select disabled={disabled} aria-label="Planar measure" className="block rounded border p-1" value={current.measure} onChange={event => { setCapture(null); update({ measure: event.target.value as PhotoPlanarDraft['measure'], measurementPoints: [] }); }}><option value="area">Surface area</option><option value="perimeter">Surface perimeter</option><option value="length">Traced length</option></select></label>
    </div>
    {!preview && <button type="button" disabled={disabled || !source} className="underline" onClick={() => onPreview(current.sourceAssetId)}>Load private source for calibration</button>}
    {preview && <div className="relative select-none touch-none" onPointerDown={mark} aria-label="Photo calibration canvas" style={{ cursor: capture ? 'crosshair' : 'default' }}>
      <img src={preview} alt={`Calibration source for ${observation.label}`} className="block w-full" referrerPolicy="no-referrer" draggable={false} />
      <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
        <polyline points={current.referencePoints.map(point => point.join(',')).join(' ') + (current.referencePoints.length === 4 ? ` ${current.referencePoints[0]!.join(',')}` : '')} fill="none" stroke="#2563eb" strokeWidth="0.005" />
        <polyline points={current.measurementPoints.map(point => point.join(',')).join(' ') + (current.measure !== 'length' && current.measurementPoints.length >= 3 ? ` ${current.measurementPoints[0]!.join(',')}` : '')} fill="none" stroke="#047857" strokeWidth="0.005" />
        {current.referencePoints.map((point, index) => <circle key={`reference:${index}`} cx={point[0]} cy={point[1]} r="0.009" fill="#2563eb" />)}
        {current.measurementPoints.map((point, index) => <circle key={`measurement:${index}`} cx={point[0]} cy={point[1]} r="0.006" fill="#047857" />)}
      </svg>
    </div>}
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={disabled || !preview} className="rounded border bg-white px-2 py-1 disabled:opacity-40" onClick={() => { update({ referencePoints: [], measurementPoints: [] }); setCapture('reference'); }}>Mark four reference corners</button>
      <button type="button" disabled={disabled || !preview || current.referencePoints.length !== 4} className="rounded border bg-white px-2 py-1 disabled:opacity-40" onClick={() => { update({ measurementPoints: [] }); setCapture('measurement'); }}>Trace measured boundary</button>
      <button type="button" disabled={disabled || current.referencePoints.length !== 4 || current.measure === 'length'} className="rounded border bg-white px-2 py-1 disabled:opacity-40" onClick={() => { update({ measurementPoints: current.referencePoints.map(point => [...point] as [number, number]) }); setCapture(null); }}>Use reference rectangle as measured surface</button>
      {capture === 'measurement' && <button type="button" className="rounded border bg-white px-2 py-1" onClick={() => setCapture(null)}>Finish boundary trace</button>}
    </div>
    <p role="status">Reference corners: {current.referencePoints.length}/4. Measured points: {current.measurementPoints.length}. {capture === 'reference' ? 'Click the next reference corner.' : capture === 'measurement' ? 'Click the actual boundary points, then finish the trace.' : 'Review the marked reference and boundary.'}</p>
    {(['rectangleVerified', 'lensDistortionReviewed', 'samePlaneReviewed', 'geometryReviewed'] as const).map((field, index) => <label key={field} className="flex gap-2"><input disabled={disabled} type="checkbox" checked={current[field]} onChange={event => update({ [field]: event.target.checked }, false)} />{['I verified this reference is a real rectangle and both physical dimensions are known.', 'I reviewed lens distortion and the image is suitable for planar calibration.', 'The measured boundary and reference are on the same flat surface.', 'I reviewed the actual measured boundary, excluding hidden or unrelated surfaces.'][index]}</label>)}
    <p className="text-amber-900">Only the marked region inside the reference is measured. Curved surfaces, holes, hidden areas and extrapolation require other evidence. This review does not quantify statistical uncertainty or certify the complete project.</p>
    <details><summary className="cursor-pointer">Advanced calibration source and coordinates</summary><pre className="overflow-auto max-h-40 whitespace-pre-wrap break-all">{JSON.stringify({ sourceAssetId: current.sourceAssetId, sourceRevision: current.sourceRevision, sourceSha256: current.sourceSha256, surfaceKey: current.surfaceKey, referencePoints: current.referencePoints, measuredPoints: current.measurementPoints }, null, 2)}</pre></details>
  </div>;
};
