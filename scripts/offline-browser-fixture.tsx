import React, { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './offline-browser-fixture.css';
import type { Project, PlanRevision } from '../apps/web/app/src/types';
import type { PhotoRun } from '../apps/web/app/src/services/photos-api';

const projectKey = 'roughbid-offline-fixture-project';
const stateKey = 'roughbid-offline-fixture-state';
const workspaceId = 'offline-workspace';
const projectId = 'offline-project';
const user = { id: 'offline-user', email: 'estimator@example.test', aud: 'authenticated', role: 'authenticated', created_at: '2026-10-02T00:00:00Z', app_metadata: {}, user_metadata: {} };
const view = new URLSearchParams(location.search).get('view') ?? 'plans';
if (view === 'reset') { localStorage.removeItem(projectKey); localStorage.removeItem(stateKey); }
const json = (data: unknown, status = 200) => Response.json(data, { status });
const fixture: any = JSON.parse(localStorage.getItem(stateKey) ?? 'null') ?? { requests: [], fullRun: null, photoRun: null, assets: [] };
fixture.requests = [];
const persist = () => localStorage.setItem(stateKey, JSON.stringify(fixture));
(window as any).__offlineFixture = fixture;
fixture.advancePlan = (status: string) => { if (fixture.fullRun) { fixture.fullRun.status = status; fixture.fullRun.progress = { completed: 4, total: 20, currentPage: null, currentPass: null }; persist(); } };
fixture.advancePhoto = () => { if (fixture.photoRun) { fixture.photoRun.status = 'needs_review'; fixture.photoRun.progress = { completed: 1, total: 1 }; fixture.photoRun.result = photoResult(); persist(); } };
fixture.setPhotoEnabled = (enabled: boolean) => { fixture.photoEnabled = enabled; persist(); };

if (view === 'auth') localStorage.removeItem('sb-127-auth-token');
else localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: 'offline-fixture-access-placeholder', refresh_token: 'offline-fixture-refresh-placeholder', token_type: 'bearer', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, user }));

function photoResult(): NonNullable<PhotoRun['result']> {
  return { assets: fixture.assets, observations: [{ id: 'offline-observation', label: 'Visible wall surface', regions: [{ sourceAssetId: fixture.assets[0]?.id ?? 'offline-photo-1', surfaceKey: 'wall-a', bbox: [0.15, 0.15, 0.6, 0.6] }], proposedQuantity: null, proposedUnit: null, referenceId: null, method: 'visual_estimate', confidence: 0.7, uncertainty: ['dimensional_reference_missing', 'hidden_surfaces_not_verified'] }], approvedMeasurements: [], blockers: ['dimension_reference_required', 'independent_review_pending', 'missing_price'], humanReviewRequired: true, releaseStatus: 'blocked', pricingStatus: 'missing_price', estimate: null, independentReview: 'pending', stageStatus: { visual_observation: 'completed', independent_reconciliation: 'pending' } };
}
const initialPass = { plan_sheet_id: 'offline-sheet-1', pass_type: 'inventory', attempt: 1, status: 'succeeded', provider: 'offline_mock', model: 'fixture', failure_classification: null, started_at: '2026-10-02T00:00:00Z', completed_at: '2026-10-02T00:00:01Z' };
const savedSheets = () => [{ id: 'offline-sheet-1', physical_page_number: 1, status: 'review_required', status_reason: 'Geometry and independent review remain pending.', passes: [initialPass] }, { id: 'offline-sheet-2', physical_page_number: 2, status: 'review_required', status_reason: 'Cross-sheet specification requires confirmation.', passes: [] }];
const nativeFetch = window.fetch.bind(window);
let geometryContext: any;
window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  if (!['http:', 'https:', 'blob:'].includes(url.protocol) || (url.protocol !== 'blob:' && url.origin !== location.origin)) {
    throw new Error('Offline fixture denies external network destinations.');
  }
  if (url.protocol === 'blob:') return nativeFetch(input, init);
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const path = url.pathname;
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
  fixture.requests.push({ method, path, query: url.search, body });
  if (path === '/api/projects/offline-project/construction-budget' && method === 'GET') return json({ quotes: fixture.quotes ?? [], snapshots: url.searchParams.has('snapshot_id') ? (fixture.snapshots ?? []).filter((saved: any) => saved.id === url.searchParams.get('snapshot_id')) : (fixture.snapshots ?? []).map((saved: any) => ({ ...saved, detailLoaded: false, result: { ...saved.result, lines: [], trace: [] } })),
    measurements: (fixture.measurements ?? []).filter((row: any) => row.review_status === 'accepted' && row.quantity !== null).map((row: any) => ({
      id: row.id, sourceKind: 'plan', runId: 'offline-geometry-run', label: row.label, quantity: row.quantity, unit: row.unit, reviewStatus: 'accepted',
      evidenceRef: 'offline-geometry-run:sheet-1:' + row.id, pageNumber: 1 })),
    pendingMeasurements: [], location: null, coverage: 'partial', humanReviewRequired: true });
  if (path === '/api/projects/offline-project/construction-budget' && method === 'POST') {
    if (body.sourceKind !== 'plan' || body.runId !== 'offline-geometry-run' || !Array.isArray(body.selections) || body.selections.length !== 1) return json({ error: 'Select one accepted offline plan measurement.' }, 422);
    const selected = body.selections[0];
    const measurement = (fixture.measurements ?? []).find((row: any) => row.id === selected.measurementId && row.review_status === 'accepted' && row.unit === 'SF' && row.quantity !== null);
    if (!measurement || selected.assemblyId !== 'RB-FLOOR-003' || 'quantity' in selected) return json({ error: 'The fixture accepts only the saved floor evidence with its server quantity.' }, 422);
    const pending = ['documented_material_quote_required', 'packaging_coverage_and_waste_pending', 'labor_productivity_and_rates_pending', 'project_location_required'];
    const snapshot = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), sourceKind: 'plan', runId: body.runId, selectionCount: 1, coverage: 'partial', humanReviewRequired: true, detailLoaded: true,
      result: { status: 'pending', knownSubtotalUsd: 0, totalUsd: null, lines: [{ id: 'offline-floor-component', itemId: selected.assemblyId, description: 'Synthetic reviewed floor — documented product quote pending', category: 'material', quantity: measurement.quantity, unit: measurement.unit, cost: null, knownSubtotal: 0, pending, formulas: [], priceSources: [] }],
        missingInputs: pending, warnings: ['Offline mocked budget response; no supplier quote or real construction price.'], trace: [{ measurementId: measurement.id, evidenceRef: 'offline-geometry-run:sheet-1:' + measurement.id, acceptedQuantity: measurement.quantity, unit: measurement.unit, geometry: measurement.geometry, calibration: measurement.calibration, assemblyId: selected.assemblyId, fixtureOnly: true }] } };
    fixture.snapshots = [snapshot, ...(fixture.snapshots ?? [])]; persist();
    // Direct snapshot shape matches the API; persistence and budget contents here remain explicit mocks.
    return json(snapshot, 201);
  }
  if (path === '/api/takeoff-runs/offline-geometry-run/measurements') {
    geometryContext ??= await (await nativeFetch('/offline-fixture/geometry-context')).json();
    fixture.measurements ??= [];
    const common = { ...geometryContext, version: 'measurement-review-v1', humanReviewRequired: true, scopeCoverage: 'selected_elements_only', pricingStatus: 'awaiting_compositions_and_price_sources' };
    if (method === 'GET') {
      if (url.searchParams.get('native_candidates') === 'true') return json({ ...common, candidates: [{ id: 'c'.repeat(64), kind: 'enclosed_space_candidate', bbox: [0.1, 0.1, 0.6, 0.6], status: 'candidate', quantity: null, unit: null, physicalPageNumber: 1, pageSha256: geometryContext.sheet.pageSha256, source: 'native_pdf_vector' }], truncated: false, limitations: ['Boxes only locate evidence and do not establish room area.'] });
      return json({ ...common, measurements: url.searchParams.has('measurement_id') ? fixture.measurements.filter((row: any) => row.id === url.searchParams.get('measurement_id')) : fixture.measurements, offset: 0, nextOffset: null });
    }
    if (method === 'POST') {
      const existing = fixture.measurements.find((row: any) => row.id === body.measurementId);
      if ((existing?.review_revision ?? 0) !== body.expectedRevision) return json({ error: 'Offline fixture review revision conflict.' }, 409);
      const validated = await nativeFetch('/offline-fixture/measurement-review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const result = await validated.json(); if (!validated.ok) return json(result, validated.status);
      const row = { id: body.measurementId, physical_page_number: body.physicalPageNumber, page_sha256: body.pageSha256, file_sha256: body.fileSha256, region_key: body.regionKey,
        region_bounds: body.regionBounds, canonical_element_key: body.canonicalElementKey, canonical_trade: body.canonicalTrade, label: body.label, geometry: body.geometry,
        source_kind: body.sourceKind, source_candidate_id: body.sourceCandidateId ?? null, quantity: result.quantity, unit: result.unit, calibration: result.calibration,
        proof: { sourceExcerpt: body.sourceExcerpt, geometryReviewed: body.geometryReviewed, identityReviewed: body.identityReviewed, duplicateReviewComplete: body.duplicateReviewComplete,
          calibrationEvidence: body.calibrationEvidence, boundaryEvidence: body.boundaryEvidence }, uncertainty: body.uncertainty, review_status: body.decision,
        review_revision: body.expectedRevision + 1, reviewed_by: 'offline-user', reviewed_at: '2026-10-02T00:00:00Z' };
      fixture.measurements = [row, ...fixture.measurements.filter((saved: any) => saved.id !== row.id)]; persist();
      return json({ measurement: row, humanReviewRequired: true, pricingStatus: common.pricingStatus });
    }
  }
  if (path === '/api/documents/offline-geometry-pdf/download-url') return json({ url: `${location.origin}/offline-fixture/geometry.pdf`, method: 'GET', headers: {}, expiresAt: '2027-01-01T00:00:00Z' });
  if (path.includes('/offline-supabase/auth/v1/user')) return json(user);
  if (path.includes('/offline-supabase/auth/v1/logout')) return json({});
  if (path === '/api/auth/magic-link') return json({ accepted: true }, 202);
  if (path === '/api/capabilities') return json({ aiReadingAvailable: true, billing: false, fullTakeoffV2Available: true });
  if (path.endsWith('/ai-plan-entitlement')) return json({ freeReadingAvailable: false, fullTakeoffV2Available: true, pilotActive: false });
  if (path.endsWith('/documents/upload-url')) return json({ file: { id: 'offline-pdf', original_name: body.name, byte_size: body.byteSize, processing_status: 'uploading' }, upload: { url: `${location.origin}/offline-storage/pdf`, method: 'PUT', headers: {} } });
  if (path === '/offline-storage/pdf' && method === 'PUT') { fixture.pdfBytes = Array.from(new Uint8Array(await new Response(init.body).arrayBuffer())); persist(); return new Response('', { status: 200 }); }
  if (path === '/api/documents/offline-pdf/complete') return json({ id: 'offline-pdf', original_name: 'offline-floor-plan.pdf', byte_size: fixture.pdfBytes?.length ?? 0, processing_status: 'ready', page_count: 2 });
  if (path === '/api/documents/offline-pdf/download-url') return json({ url: `${location.origin}/offline-storage/pdf`, method: 'GET', headers: {} });
  if (path === '/offline-storage/pdf') return new Response(new Uint8Array(fixture.pdfBytes ?? []), { headers: { 'content-type': 'application/pdf' } });
  if (path.endsWith('/ai-plan-readings') && method === 'POST') {
    if (body.mode !== 'full_v2') return json({ error: 'Only Full V2 is enabled in this offline fixture.' }, 409);
    fixture.fullRun = { id: 'offline-full-run', mode: 'full_v2', status: 'processing', progress: { completed: 1, total: 20, currentPage: 1, currentPass: 'inventory' }, sheets: savedSheets(), output_summary: { takeoff_v2: { releaseStatus: 'blocked', budgetStatus: 'missing_price', humanReviewRequired: true } } }; persist(); return json(fixture.fullRun, 202);
  }
  if (path === '/api/takeoff-runs/offline-full-run/cancel') { fixture.fullRun.status = 'cancelled'; persist(); return json({ id: fixture.fullRun.id, status: 'cancelled' }); }
  if (path === '/api/takeoff-runs/offline-full-run/restart') { fixture.fullRun.status = 'processing'; persist(); return json({ id: fixture.fullRun.id, status: 'processing' }); }
  if (path === '/api/takeoff-runs/offline-full-run') {
    if (url.searchParams.has('page_number')) return json({ id: fixture.fullRun.id, mode: 'full_v2', sheet: savedSheets()[0], pass: { ...initialPass, checkpoint: { observations: [{ description: 'Fixture sheet A1 shows a rectangular room with an explicit 12 ft × 10 ft dimension.', source_excerpt: 'A1: room reference dimensions 12 ft × 10 ft; independent verification pending.' }], blockers: ['geometry_cross_sheet_review_pending', 'missing_price'], deterministic_scale: { calibration: { verificationStatus: 'unverified' }, evidence: [] } } } });
    return json(fixture.fullRun);
  }
  if (path.endsWith('/photos/capability')) return json({ enabled: fixture.photoEnabled !== false, ownerAccess: true, workerReady: true, provider: 'offline_mock', model: 'fixture' });
  if (path.endsWith('/photos/uploads') && method === 'POST') {
    const id = `offline-photo-${fixture.assets.length + 1}`;
    fixture.pendingAsset = { id, workspaceId, projectId, sha256: 'a'.repeat(64), revision: `fixture-revision-${fixture.assets.length + 1}`, mimeType: body.contentType, byteSize: body.byteSize, widthPixels: 800, heightPixels: 600, storageVerified: true }; persist();
    return json({ asset: { id, original_name: body.name }, upload: { url: `${location.origin}/offline-storage/photo`, method: 'PUT', headers: {} } });
  }
  if (path === '/offline-storage/photo' && method === 'PUT') {
    const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
    fixture.photoBytes = Array.from(bytes);
    fixture.pendingAsset.sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
    fixture.pendingAsset.revision = fixture.pendingAsset.sha256;
    persist(); return new Response('', { status: 200 });
  }
  if (/\/photos\/uploads\/[^/]+\/complete$/.test(path)) { fixture.assets.push(fixture.pendingAsset); persist(); return json({ asset: fixture.pendingAsset }); }
  if (/\/photos\/uploads\/[^/]+\/download-url$/.test(path)) return json({ url: `${location.origin}/offline-storage/photo`, method: 'GET', headers: {} });
  if (path === '/offline-storage/photo') return new Response(new Uint8Array(fixture.photoBytes ?? []), { headers: { 'content-type': 'image/png' } });
  if (path.endsWith('/photos/runs') && method === 'POST') { fixture.photoRun = { id: 'offline-photo-run', status: 'processing', request_key: body.requestKey, asset_ids: body.assetIds, progress: { completed: 0, total: 1 }, result: null, created_at: '2026-10-02T00:00:00Z' }; persist(); return json({ run: fixture.photoRun, enqueued: true }, 202); }
  if (path.endsWith('/photos/runs')) return json({ runs: fixture.photoRun ? [{ ...fixture.photoRun, result: undefined }] : [] });
  if (path.endsWith('/photos/runs/offline-photo-run/cancel')) { fixture.photoRun.status = 'cancelled'; persist(); return json({ id: fixture.photoRun.id, status: 'cancelled' }); }
  if (path.endsWith('/photos/runs/offline-photo-run/review')) {
    const decision = body.decisions[0]; const review = photoResult();
    review.references = body.references; review.decisions = body.decisions;
    review.approvedMeasurements = decision.disposition === 'approved' ? [{ id: 'offline-approved', objectIdentityKey: decision.objectIdentityKey, quantity: decision.quantity, unit: decision.unit, method: decision.method, calculationMethod: decision.calculationMethod, sourceRegions: review.observations[0].regions, sourceRevisions: {}, referenceIds: decision.referenceId ? [decision.referenceId] : [], reviewerIds: ['offline-user'] }] : [];
    fixture.photoRun.result = review; persist(); return json({ review });
  }
  if (path.endsWith('/photos/runs/offline-photo-run')) return json({ run: fixture.photoRun, assets: fixture.assets, references: fixture.photoRun?.result?.references ?? [], steps: fixture.assets.map((asset: any) => ({ photo_asset_id: asset.id, status: fixture.photoRun.status === 'needs_review' ? 'completed' : 'pending', result: null })) });
  if (path.startsWith('/api/') || path.startsWith('/offline-supabase/')) return json({ error: `Unmocked offline endpoint: ${path}` }, 501);
  return nativeFetch(input, init);
};

const { AuthGate } = await import('../apps/web/app/src/components/AuthGate');
const { PlansPage } = await import('../apps/web/app/src/pages/PlansPageContent');
const { AIPlanModal } = await import('../apps/web/app/src/components/AIPlanModal');
const { PlanMeasurementPanel } = await import('../apps/web/app/src/components/PlanMeasurementPanel');
const { SaasPricingPreview } = await import('../apps/web/app/src/components/SaasPricingPreview');
const emptyProject: Project = { id: 'offline-local-project', remoteId: projectId, name: 'Offline synthetic floor plan', clientName: 'Offline fixture', address: 'No real location', projectType: 'New Construction', status: 'Planning', updatedAt: '2026-10-02', overheadPercentage: 0, markupPercentage: 0, revisions: [], quantities: [], estimateItems: [] };
function FixtureApp() {
  const [project, setProject] = useState<Project>(() => JSON.parse(localStorage.getItem(projectKey) ?? 'null') ?? emptyProject);
  const [open, setOpen] = useState(false);
  const update = useCallback((next: Project) => { localStorage.setItem(projectKey, JSON.stringify(next)); setProject(next); }, []);
  const append = useCallback((revision: PlanRevision) => setProject(current => { const next = { ...current, revisions: [...current.revisions.map(item => ({ ...item, isCurrent: false })), revision] }; localStorage.setItem(projectKey, JSON.stringify(next)); return next; }), []);
  const patch = useCallback((id: string, change: Partial<PlanRevision>) => setProject(current => { const next = { ...current, revisions: current.revisions.map(item => item.id === id ? { ...item, ...change } : item) }; localStorage.setItem(projectKey, JSON.stringify(next)); return next; }), []);
  return <><aside role="note" className="sticky top-0 z-[100] bg-amber-100 text-amber-950 p-3 text-sm font-semibold">OFFLINE FIXTURE — synthetic sources, mocked APIs and browser-only saved state. No production login, worker or paid provider call.</aside>
    {view === 'geometry' || view === 'geometry-viewer' ? <div className="max-w-6xl mx-auto p-4"><PlanMeasurementPanel workspaceId={workspaceId} runId="offline-geometry-run" pageNumber={1} canWrite={view === 'geometry'} /></div> : view === 'pricing' || view === 'pricing-viewer' ? <div className="max-w-6xl mx-auto p-4"><SaasPricingPreview isPlatformAdmin={view === 'pricing'} /></div> : view === 'auth' ? <AuthGate /> : <><PlansPage canWrite={view !== 'viewer'} workspaceId={workspaceId} project={project} onAppendRevision={append} onPatchRevision={patch} onUpdateProject={update} onContinue={() => undefined} onOpenAIAssistant={() => setOpen(true)} />
      <AIPlanModal project={project} workspaceId={workspaceId} isOpen={open} canWrite={view !== 'viewer'} onClose={() => setOpen(false)} onAddQuantityItem={() => { throw new Error('Fixture must never create estimate quantities from Full V2 observations.'); }} /></>}
  </>;
}
createRoot(document.getElementById('root')!).render(<FixtureApp />);
(window as any).__offlineFixtureReady = true;
