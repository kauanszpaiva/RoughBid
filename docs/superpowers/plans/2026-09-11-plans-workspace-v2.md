# RoughBid Plans Workspace V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the RoughBid Plans screen into a full-height professional blueprint workspace with sheet thumbnails, a larger PDF reader, single/continuous modes, source-grounded AI navigation, inspector panels, focus mode, and preserved page-review/billing/entitlement safety semantics.

**Architecture:** Keep `PlansPageContent.tsx` as the business/controller boundary for upload, preview URL, entitlements, billing, consent, AI jobs, and revisions. Move viewer-only responsibilities into `apps/web/app/src/features/plans/**`: pure geometry/viewport utilities, PDF document/render hooks, sheet navigation, a central canvas, contextual inspector panels, and explicit page-review integration. Preserve `pdfjs-dist` as the PDF engine and use the repository's existing Node test + isolated Playwright browser-verification approach.

**Tech Stack:** React 19, TypeScript 5.8, Vite 6, Tailwind CSS 4, `pdfjs-dist` 6.3.289, `lucide-react`, Node `node:test`, `pdf-lib` synthetic fixtures, Playwright 1.58.2 in `.browser-tests`.

**Spec:** `docs/superpowers/specs/2026-09-11-plans-workspace-v2-design.md`

## Global Constraints

- The blueprint must be the dominant visual surface.
- `PlansPageContent.tsx` remains authoritative for upload, preview URL creation, entitlements, reading quote/payment recovery, AI consent, paid/included analysis start, current revision actions, and persisted project update callbacks during this redesign.
- Do not rewrite AI providers, pricing, Stripe semantics, workspace entitlement rules, storage, or consent rules.
- Do not enable `TAKEOFF_V2_*` flags as part of this work.
- Opening Plans, changing PDF page/view mode, opening the AI inspector, or opening Page Review must never start a metered AI request.
- Loading Page Review inventory remains read-only and must not invoke a model.
- Physical-page analysis remains explicit, skips already-saved pages, never silently replays uncertain POST requests, and reconciles server state after uncertainty.
- Never invent finding geometry or source pages in the client.
- Do not present processed pages as proof of exhaustive takeoff completeness.
- Do not add a new global state library or replace PDF.js.
- Do not persist UI-only zoom/panel/focus state as project business data.
- No secrets may be committed.
- Keep the existing API boundary: frontend backend calls continue through `apps/web/app/src/services/api.ts`.

---

## File Structure Locked by This Plan

### New feature files

- `apps/web/app/src/features/plans/types.ts` — viewer-only state and shared component interfaces.
- `apps/web/app/src/features/plans/utils/findingGeometry.ts` — validation and source-target helpers for AI findings.
- `apps/web/app/src/features/plans/utils/viewport.ts` — zoom, fit, page-range, and active-page calculations.
- `apps/web/app/src/features/plans/hooks/usePdfDocument.ts` — load/destroy the PDF.js document for a preview URL.
- `apps/web/app/src/features/plans/hooks/useBlueprintViewport.ts` — fit-mode sizing, zoom, pan keyboard/pointer state, and viewport measurements.
- `apps/web/app/src/features/plans/hooks/useContinuousPages.ts` — near-viewport page render window and active-page synchronization.
- `apps/web/app/src/features/plans/hooks/useFindingNavigation.ts` — finding selection -> physical page -> validated target -> scroll/zoom request.
- `apps/web/app/src/features/plans/viewer/BlueprintPage.tsx` — one cancelable PDF.js page render plus overlays.
- `apps/web/app/src/features/plans/viewer/FindingOverlay.tsx` — selected/visible AI markers and valid bounding boxes.
- `apps/web/app/src/features/plans/viewer/AnnotationOverlay.tsx` — manual note markers and pending-note marker.
- `apps/web/app/src/features/plans/viewer/BlueprintToolbar.tsx` — page, pan, zoom, fit, layers, note, view-mode, and focus controls.
- `apps/web/app/src/features/plans/viewer/BlueprintCanvas.tsx` — single/continuous blueprint surface and pan/note pointer handling.
- `apps/web/app/src/features/plans/sheets/SheetThumbnail.tsx` — lazy low-resolution PDF thumbnail.
- `apps/web/app/src/features/plans/sheets/SheetNavigator.tsx` — searchable physical-page navigation.
- `apps/web/app/src/features/plans/inspector/FindingsPanel.tsx` — AI finding search/filter/evidence list.
- `apps/web/app/src/features/plans/inspector/TakeoffPanel.tsx` — area-grouped existing findings/quantities without fabricating prices.
- `apps/web/app/src/features/plans/inspector/NotesPanel.tsx` — manual notes across pages.
- `apps/web/app/src/features/plans/inspector/PlanInfoPanel.tsx` — file/revision metadata and existing plan actions.
- `apps/web/app/src/features/plans/inspector/PageReviewPanel.tsx` — feature-local presentation of the existing explicit/resumable owner page-review workflow.
- `apps/web/app/src/features/plans/inspector/PlanInspector.tsx` — AI/Takeoff/Notes/Plan tab shell.
- `apps/web/app/src/features/plans/PlansWorkspace.tsx` — full-height three-region workspace composition.

### Tests and verification

- `apps/web/test/plans-finding-geometry.test.ts` — source geometry validity and unmapped behavior.
- `apps/web/test/plans-viewport.test.ts` — zoom/fit/continuous page calculations.
- `scripts/test-plans-workspace-browser.mjs` — integrated synthetic PDF workspace verification.
- Modify `scripts/test-page-review-browser.mjs` — import the migrated feature-local panel and prove no automatic/replayed requests.
- Modify `.github/workflows/durable-ai-plan.yml` — run the new workspace browser verifier after the production build and browser install.

### Existing integration files

- Modify `apps/web/app/src/pages/PlansPageContent.tsx` — replace the old dashboard grid / `BlueprintViewer` rendering with `PlansWorkspace` and pass existing actions/state as props.
- Modify `apps/web/app/src/pages/PlansPage.tsx` — move owner Page Review from the page-level block into the workspace inspector while preserving the `pageReviewBusy` write lock and pricing-context wrapper.
- Remove `apps/web/app/src/components/BlueprintViewer.tsx` after all consumers and browser checks have migrated.
- Remove `apps/web/app/src/components/PageReviewPanel.tsx` after the feature-local panel passes the existing regression harness.

---

### Task 1: Extract and lock source geometry + viewport math

**Files:**
- Create: `apps/web/app/src/features/plans/types.ts`
- Create: `apps/web/app/src/features/plans/utils/findingGeometry.ts`
- Create: `apps/web/app/src/features/plans/utils/viewport.ts`
- Create: `apps/web/test/plans-finding-geometry.test.ts`
- Create: `apps/web/test/plans-viewport.test.ts`

**Interfaces:**
- Consumes: `PlanReadingFinding` from `apps/web/app/src/services/api.ts`.
- Produces: `getValidFindingBox()`, `getValidFindingPoint()`, `getFindingTarget()`, `clampZoom()`, `computeFitWidthZoom()`, `computeFitPageZoom()`, `getContinuousRenderWindow()`, `pickActivePage()`.

- [ ] **Step 1: Write failing geometry tests**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PlanReadingFinding } from '../app/src/services/api.ts';
import { getFindingTarget, getValidFindingBox, getValidFindingPoint } from '../app/src/features/plans/utils/findingGeometry.ts';

const finding = (geometry: Record<string, unknown>, page_number: number | null = 3): PlanReadingFinding => ({
  id: 'f', page_number, finding_type: 'material', label: 'Wall', value_text: null,
  quantity: null, unit: null, confidence: 0.9, geometry, source_excerpt: 'source', status: 'needs_review',
});

test('accepts only normalized in-page boxes', () => {
  assert.deepEqual(getValidFindingBox(finding({ bbox: [0.1, 0.2, 0.3, 0.4] })), [0.1, 0.2, 0.3, 0.4]);
  assert.equal(getValidFindingBox(finding({ bbox: [0.9, 0.2, 0.3, 0.4] })), null);
  assert.equal(getValidFindingBox(finding({ bbox: [-0.1, 0.2, 0.3, 0.4] })), null);
});

test('bbox center wins over point and no geometry stays unmapped', () => {
  assert.deepEqual(getValidFindingPoint(finding({ bbox: [0.2, 0.2, 0.2, 0.2], point: [0.9, 0.9] })), { x: 0.3, y: 0.3 });
  assert.deepEqual(getFindingTarget(finding({}), 10), { kind: 'page', page: 3 });
  assert.deepEqual(getFindingTarget(finding({ point: [0.5, 0.25] }), 10), { kind: 'point', page: 3, point: { x: 0.5, y: 0.25 } });
  assert.equal(getFindingTarget(finding({ point: [0.5, 0.25] }, 99), 10), null);
});
```

- [ ] **Step 2: Write failing viewport tests**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { clampZoom, computeFitPageZoom, computeFitWidthZoom, getContinuousRenderWindow, pickActivePage } from '../app/src/features/plans/utils/viewport.ts';

test('zoom is clamped to 25-500 percent', () => {
  assert.equal(clampZoom(5), 25);
  assert.equal(clampZoom(125), 125);
  assert.equal(clampZoom(900), 500);
});

test('fit calculations honor page and viewport dimensions', () => {
  assert.equal(computeFitWidthZoom({ pageWidth: 1000, viewportWidth: 800, horizontalPadding: 40 }), 76);
  assert.equal(computeFitPageZoom({ pageWidth: 1000, pageHeight: 800, viewportWidth: 800, viewportHeight: 600, padding: 40 }), 70);
});

test('continuous render window stays bounded around the active page', () => {
  assert.deepEqual(getContinuousRenderWindow({ activePage: 10, totalPages: 50, radius: 2 }), [8, 9, 10, 11, 12]);
  assert.deepEqual(getContinuousRenderWindow({ activePage: 1, totalPages: 3, radius: 2 }), [1, 2, 3]);
});

test('active page is the page with the largest visible ratio', () => {
  assert.equal(pickActivePage([{ page: 4, ratio: 0.2 }, { page: 5, ratio: 0.8 }, { page: 6, ratio: 0.3 }]), 5);
});
```

- [ ] **Step 3: Run the two tests and confirm the imports fail**

Run:

```bash
node --experimental-strip-types --test apps/web/test/plans-finding-geometry.test.ts apps/web/test/plans-viewport.test.ts
```

Expected: FAIL because the feature utility files do not exist yet.

- [ ] **Step 4: Implement the minimal typed utilities**

`findingGeometry.ts` must validate numbers, page bounds, and bbox extent before returning geometry. `getFindingTarget(finding, totalPages)` returns one of:

```ts
export type FindingTarget =
  | { kind: 'box'; page: number; box: readonly [number, number, number, number] }
  | { kind: 'point'; page: number; point: Readonly<{ x: number; y: number }> }
  | { kind: 'page'; page: number };
```

`viewport.ts` must round fit percentages to whole numbers before `clampZoom()`, use `Math.min(widthScale, heightScale)` for Fit Page, and return a bounded continuous render window.

- [ ] **Step 5: Run tests and web typecheck**

```bash
node --experimental-strip-types --test apps/web/test/plans-finding-geometry.test.ts apps/web/test/plans-viewport.test.ts
npx tsc --noEmit -p apps/web/app/tsconfig.json
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/src/features/plans/types.ts apps/web/app/src/features/plans/utils apps/web/test/plans-finding-geometry.test.ts apps/web/test/plans-viewport.test.ts
git commit -m "feat(plans): add source geometry and viewport contracts"
```

---

### Task 2: Build the PDF document hook and one-page render primitive

**Files:**
- Create: `apps/web/app/src/features/plans/hooks/usePdfDocument.ts`
- Create: `apps/web/app/src/features/plans/viewer/BlueprintPage.tsx`
- Create: `apps/web/app/src/features/plans/viewer/FindingOverlay.tsx`
- Create: `apps/web/app/src/features/plans/viewer/AnnotationOverlay.tsx`
- Modify: `scripts/test-blueprint-browser.mjs` temporarily only if needed to exercise the new primitive before workspace composition; final harness moves to Task 7.

**Interfaces:**
- `usePdfDocument(previewUrl)` -> `{ pdf, status, error }`.
- `BlueprintPage` consumes `PDFDocumentProxy`, physical page number, zoom scale, findings, annotations, layer flags, selection state, and note/source callbacks.
- `BlueprintPage` produces `onPageMetrics(page, { width, height })` and render status via visible DOM state.

- [ ] **Step 1: Preserve the existing stale-render cancellation contract in the new component**

Implement the page renderer with a detached staging canvas and a cleanup that calls `renderTask.cancel()`.

```tsx
useEffect(() => {
  if (!pdf) return;
  let cancelled = false;
  let renderTask: ReturnType<pdfjs.PDFPageProxy['render']> | undefined;

  void (async () => {
    const page = await pdf.getPage(pageNumber);
    if (cancelled || !canvasRef.current) return;
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale });
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const staging = document.createElement('canvas');
    staging.width = Math.ceil(viewport.width * pixelRatio);
    staging.height = Math.ceil(viewport.height * pixelRatio);
    const context = staging.getContext('2d');
    if (!context) throw new Error('PDF preview is unavailable in this browser.');
    renderTask = page.render({ canvas: staging, canvasContext: context, viewport, transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] });
    await renderTask.promise;
    if (cancelled || !canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = staging.width;
    canvas.height = staging.height;
    canvas.getContext('2d')?.drawImage(staging, 0, 0);
  })();

  return () => { cancelled = true; renderTask?.cancel(); };
}, [pdf, pageNumber, scale]);
```

- [ ] **Step 2: Implement `usePdfDocument` with abort/destroy cleanup**

Use the existing worker configuration and load bytes from the already-authorized `previewUrl`. Do not add a backend fetch from this hook.

```ts
export function usePdfDocument(previewUrl: string | null | undefined) {
  const [state, setState] = useState<PdfDocumentState>({ pdf: null, status: previewUrl ? 'loading' : 'idle', error: null });
  // fetch(previewUrl) -> arrayBuffer -> pdfjs.getDocument({ data })
  // cleanup: AbortController.abort() and loadingTask.destroy()
  return state;
}
```

- [ ] **Step 3: Move overlay rules without changing truth semantics**

`FindingOverlay.tsx` must call `getValidFindingBox()` / `getValidFindingPoint()` and render nothing for invalid geometry. `AnnotationOverlay.tsx` uses the persisted normalized `PlanAnnotation.x/y` only.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit -p apps/web/app/tsconfig.json
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/src/features/plans/hooks/usePdfDocument.ts apps/web/app/src/features/plans/viewer/BlueprintPage.tsx apps/web/app/src/features/plans/viewer/FindingOverlay.tsx apps/web/app/src/features/plans/viewer/AnnotationOverlay.tsx
git commit -m "feat(plans): extract cancelable PDF page rendering"
```

---

### Task 3: Add viewport control, toolbar, pan, zoom, fit, and focus semantics

**Files:**
- Create: `apps/web/app/src/features/plans/hooks/useBlueprintViewport.ts`
- Create: `apps/web/app/src/features/plans/viewer/BlueprintToolbar.tsx`
- Modify: `apps/web/app/src/features/plans/types.ts`

**Interfaces:**
- `useBlueprintViewport()` produces `zoomPercent`, `fitMode`, `setManualZoom`, `fitWidth`, `fitPage`, `isHandTool`, `setHandTool`, `viewportRef`, and pan pointer handlers.
- Toolbar emits only UI actions; it performs no API calls.

- [ ] **Step 1: Add keyboard/input guard helper to the viewport tests**

Add a pure helper in `viewport.ts`:

```ts
export function shouldIgnoreViewerShortcut(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || Boolean(target instanceof HTMLElement && target.isContentEditable);
}
```

Test it in a browser-facing integration later; for Node, keep shortcut dispatch logic isolated so DOM construction is not required.

- [ ] **Step 2: Implement fit-mode recalculation with `ResizeObserver`**

When `fitMode === 'width'` or `fitMode === 'page'`, recalculate on measured viewport/page dimensions. Manual zoom must set `fitMode` to `manual`.

- [ ] **Step 3: Implement zoom controls**

Use 10% toolbar increments and Ctrl/Cmd+wheel progressive deltas, always routed through `clampZoom()`.

```ts
const setManualZoom = (next: number) => {
  setFitMode('manual');
  setZoomPercent(clampZoom(next));
};
```

After wheel zoom, adjust scroll position around the pointer using old/new scale ratios so the inspected point moves minimally.

- [ ] **Step 4: Implement pan without conflicting with note placement**

A pan begins when Hand tool is active, Space is held with primary button, or middle mouse is used. Expose `isPanning` so `BlueprintCanvas` can block note placement during drag.

- [ ] **Step 5: Implement accessible toolbar controls**

Toolbar must expose accessible names exactly usable by browser tests: `Previous PDF page`, `Next PDF page`, `Zoom out`, `Zoom in`, `Fit width`, `Fit page`, `Actual size`, `Hand tool`, `Layers`, `Add note`, `View mode`, `Focus mode`.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit -p apps/web/app/tsconfig.json
git add apps/web/app/src/features/plans/hooks/useBlueprintViewport.ts apps/web/app/src/features/plans/viewer/BlueprintToolbar.tsx apps/web/app/src/features/plans/types.ts apps/web/app/src/features/plans/utils/viewport.ts apps/web/test/plans-viewport.test.ts
git commit -m "feat(plans): add professional blueprint viewport controls"
```

---

### Task 4: Build sheet thumbnails and primary sheet navigation

**Files:**
- Create: `apps/web/app/src/features/plans/sheets/SheetThumbnail.tsx`
- Create: `apps/web/app/src/features/plans/sheets/SheetNavigator.tsx`
- Modify: `apps/web/app/src/features/plans/types.ts`

**Interfaces:**
- `SheetNavigator` consumes `pdf`, `activePage`, optional known sheet labels, optional page-review inventory, and `onSelectPage(page)`.
- `SheetThumbnail` renders one low-resolution page and cancels stale thumbnail work.

- [ ] **Step 1: Define sheet metadata without fabricated labels**

```ts
export type PlanSheet = {
  page: number;
  label: string;
  title?: string;
};

export function fallbackSheetLabel(page: number): string {
  return `Page ${String(page).padStart(2, '0')}`;
}
```

Known AI/document metadata may populate `label/title`; otherwise use only the fallback physical page label.

- [ ] **Step 2: Implement low-resolution thumbnail rendering**

Render to a target CSS width around 140 px; derive scale from `page.getViewport({ scale: 1 })`. Keep DPR capped at 1.5 for thumbnails and cancel stale render tasks.

- [ ] **Step 3: Implement searchable/keyboard Sheet Navigator**

The search filters displayed labels/titles only. ArrowUp/ArrowDown changes the selected physical page when focus is inside the navigator and the user is not typing in its search input.

- [ ] **Step 4: Add optional page-review status badges**

Badges are derived from already-loaded `PageReviewInventory.pages`. They must never call `getPageReviewInventory()` themselves.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit -p apps/web/app/tsconfig.json
git add apps/web/app/src/features/plans/sheets apps/web/app/src/features/plans/types.ts
git commit -m "feat(plans): add sheet thumbnails and navigator"
```

---

### Task 5: Move findings, takeoff, notes, plan actions, and owner Page Review into the Inspector

**Files:**
- Create: `apps/web/app/src/features/plans/inspector/FindingsPanel.tsx`
- Create: `apps/web/app/src/features/plans/inspector/TakeoffPanel.tsx`
- Create: `apps/web/app/src/features/plans/inspector/NotesPanel.tsx`
- Create: `apps/web/app/src/features/plans/inspector/PlanInfoPanel.tsx`
- Create: `apps/web/app/src/features/plans/inspector/PageReviewPanel.tsx`
- Create: `apps/web/app/src/features/plans/inspector/PlanInspector.tsx`
- Modify: `scripts/test-page-review-browser.mjs`

**Interfaces:**
- FindingsPanel emits `onSelectFinding(id)`.
- TakeoffPanel consumes `groupAiFindingsByArea(findings)` and emits finding selection only; it does not calculate replacement prices.
- NotesPanel emits `onSelectAnnotation(id)`.
- PlanInfoPanel receives existing rename/upload/download/delete/revision callbacks from `PlansPageContent`.
- PageReviewPanel keeps the current public props: `workspaceId`, `projectId`, `fileId`, `scope`, `canWrite`, `onBusyChange`, `onOpenJob`.

- [ ] **Step 1: Copy the Page Review logic into the feature-local component before changing behavior or markup**

Preserve these exact request rules:

```ts
const existing = inventory.pages.find(page => page.pageNumber === number);
if (!existing || existing.jobId) continue;
const job = await startPhysicalPageReading(...);
```

and on uncertain failure:

```ts
const reconciled = await getPageReviewInventory(...);
setInventory(reconciled);
// No automatic startPhysicalPageReading() retry here.
```

- [ ] **Step 2: Point the existing browser regression at the new file and run it**

Update the harness import to:

```tsx
import { PageReviewPanel } from '../apps/web/app/src/features/plans/inspector/PageReviewPanel';
```

and update the Vite resolver's importer suffix from `/PageReviewPanel.tsx` if required while keeping the same API stub.

Run:

```bash
node scripts/test-page-review-browser.mjs
```

Expected: PASS with call sequence `[2,3]`, no call from inventory load, no replay after the synthetic failure, and no customer-visible owner panel.

- [ ] **Step 3: Build FindingsPanel with grounded mapped/unmapped state**

Rows must show page, confidence, quantity/value when present, and a text indicator such as `Mapped`/`Unmapped`; a finding with no valid point/box may still be selected if it has a valid physical page.

- [ ] **Step 4: Build TakeoffPanel from existing area grouping**

Import `groupAiFindingsByArea` from `apps/web/app/src/utils/aiFindingReview.ts`. Show `Costs not configured` / review-required semantics where the source data lacks pricing; do not turn `unpricedCount` into a price.

- [ ] **Step 5: Build NotesPanel and PlanInfoPanel**

Notes list `annotation.page` and `annotation.text`. PlanInfoPanel receives callbacks instead of owning business mutations.

- [ ] **Step 6: Build accessible tab shell**

Use tabs `AI`, `Takeoff`, `Notes`, `Plan`; within `AI`, expose `Findings` and `Page Review` only when page-review props are available. Merely switching tabs performs no metered call.

- [ ] **Step 7: Typecheck, rerun P0 browser check, commit**

```bash
npx tsc --noEmit -p apps/web/app/tsconfig.json
node scripts/test-page-review-browser.mjs
git add apps/web/app/src/features/plans/inspector scripts/test-page-review-browser.mjs
git commit -m "feat(plans): move review context into inspector"
```

---

### Task 6: Implement source-grounded finding navigation and layer behavior

**Files:**
- Create: `apps/web/app/src/features/plans/hooks/useFindingNavigation.ts`
- Modify: `apps/web/app/src/features/plans/viewer/FindingOverlay.tsx`
- Modify: `apps/web/app/src/features/plans/viewer/BlueprintCanvas.tsx` if already created during Task 7 preparation; otherwise this hook is wired in Task 7.
- Modify: `apps/web/app/src/features/plans/inspector/FindingsPanel.tsx`

**Interfaces:**
- `useFindingNavigation({ pdfPageCount, setActivePage, setManualZoom, getPageElement, scrollContainer })` exposes `focusFinding(finding)`.
- `focusFinding()` consumes only `getFindingTarget()` validated output.

- [ ] **Step 1: Add a pure bbox zoom target helper test**

Extend `plans-viewport.test.ts`:

```ts
import { computeBoxFocusZoom } from '../app/src/features/plans/utils/viewport.ts';

test('box focus zoom fits the bbox with margin and obeys limits', () => {
  assert.equal(computeBoxFocusZoom({ boxWidth: 0.5, boxHeight: 0.5, currentZoom: 100, viewportWidth: 1000, viewportHeight: 800 }), 144);
  assert.equal(computeBoxFocusZoom({ boxWidth: 0.01, boxHeight: 0.01, currentZoom: 100, viewportWidth: 1000, viewportHeight: 800 }), 500);
});
```

Use a fixed 72% target occupancy in both dimensions, round, then clamp 25-500.

- [ ] **Step 2: Run the test and confirm it fails**

```bash
node --experimental-strip-types --test apps/web/test/plans-viewport.test.ts
```

- [ ] **Step 3: Implement `computeBoxFocusZoom` and `useFindingNavigation`**

Behavior:
- invalid page -> return without navigation;
- `kind: 'page'` -> change page, open evidence, no synthetic marker;
- `kind: 'point'` -> change page then scroll point to center at a useful current zoom;
- `kind: 'box'` -> change page, compute bounded focus zoom, then center bbox after render/layout settles.

- [ ] **Step 4: Make overlay noise selection-driven**

Default: AI markers visible; non-selected boxes use subdued styling or stay hidden according to `showFindingHighlights`; selected box is strong and source-grounded. Manual notes remain blue and independently toggleable.

- [ ] **Step 5: Run tests/typecheck and commit**

```bash
node --experimental-strip-types --test apps/web/test/plans-finding-geometry.test.ts apps/web/test/plans-viewport.test.ts
npx tsc --noEmit -p apps/web/app/tsconfig.json
git add apps/web/app/src/features/plans/hooks/useFindingNavigation.ts apps/web/app/src/features/plans/viewer/FindingOverlay.tsx apps/web/app/src/features/plans/inspector/FindingsPanel.tsx apps/web/app/src/features/plans/utils/viewport.ts apps/web/test/plans-viewport.test.ts
git commit -m "feat(plans): add grounded finding fly-to navigation"
```

---

### Task 7: Assemble `BlueprintCanvas` + `PlansWorkspace` with Single and Continuous modes

**Files:**
- Create: `apps/web/app/src/features/plans/hooks/useContinuousPages.ts`
- Create: `apps/web/app/src/features/plans/viewer/BlueprintCanvas.tsx`
- Create: `apps/web/app/src/features/plans/PlansWorkspace.tsx`
- Create: `scripts/test-plans-workspace-browser.mjs`

**Interfaces:**
- PlansWorkspace consumes current revision, preview URL/loading/error, findings, canWrite, project name, annotations callback, inspector business-action props, optional page-review props, and `onContinue`/`onOpenAIAssistant` if still surfaced in the workspace shell.
- BlueprintCanvas owns no billing/upload/API behavior.

- [ ] **Step 1: Write the synthetic workspace browser test before the component exists**

Create a 23-page `pdf-lib` fixture like the current blueprint browser test. Render `PlansWorkspace` with three synthetic findings:

```ts
const findings = [
  { id:'mapped-box', page_number:3, finding_type:'material', label:'Exterior wall', value_text:null, quantity:40, unit:'LF', confidence:.95, geometry:{bbox:[.2,.2,.2,.2]}, source_excerpt:'Exterior bearing wall', status:'needs_review' },
  { id:'mapped-point', page_number:5, finding_type:'risk', label:'Header check', value_text:null, quantity:null, unit:null, confidence:.72, geometry:{point:[.6,.4]}, source_excerpt:'Verify header', status:'needs_review' },
  { id:'unmapped', page_number:7, finding_type:'scope_note', label:'General note', value_text:'Review', quantity:null, unit:null, confidence:.8, geometry:{}, source_excerpt:'General note', status:'needs_review' },
];
```

Initial assertions must require:
- region `Synthetic Plans workspace` visible;
- `Sheets` navigation visible on desktop;
- only the blueprint section, not a findings list, occupies the main center column;
- 23 sheet buttons exist;
- page 1 canvas renders;
- selecting page 23 from Sheet Navigator changes canvas aria-label to page 23;
- mapped finding jumps to page 3 and shows selected evidence;
- unmapped finding jumps to page 7 and has no AI marker element for that finding;
- focus mode hides Sheets + Inspector and Escape restores them.

Run:

```bash
npm run build:app
node scripts/test-plans-workspace-browser.mjs
```

Expected before implementation: build/test FAIL because `PlansWorkspace` does not exist.

- [ ] **Step 2: Implement the full-height three-region workspace shell**

Use grid/flex without `max-w-6xl mx-auto`. Desktop target columns are approximately `200-230px / minmax(0,1fr) / 320-380px`. Add collapse buttons; at narrow widths, panels become fixed/absolute drawers over the canvas.

- [ ] **Step 3: Implement Single mode in `BlueprintCanvas`**

Render exactly the active physical page as the main page. Wire toolbar, page navigator, overlays, manual note placement, and viewport hook.

- [ ] **Step 4: Implement Continuous mode with bounded render window**

`useContinuousPages` uses `IntersectionObserver` entries to update active page via `pickActivePage()`. Only pages in `getContinuousRenderWindow({ activePage, totalPages, radius: 2 })` mount `BlueprintPage`; other pages render dimension-preserving placeholders.

- [ ] **Step 5: Preserve active physical page across mode changes**

`Single -> Continuous` scrolls the active page into view; `Continuous -> Single` keeps the last active page.

- [ ] **Step 6: Implement Focus Mode as a fixed workspace overlay**

Use a fixed high-z-index workspace presentation so the surrounding app sidebar/header need not be refactored. Hide Sheet Navigator and Inspector in Focus Mode, keep toolbar visible, and exit on Escape.

- [ ] **Step 7: Implement manual note creation in the new canvas**

Only create a pending note when `canWrite && noteMode && !isPanning && pageRenderReady`. Persist exactly normalized `{ page, x, y, text.slice(0,500) }` via the callback from `PlansPageContent`.

- [ ] **Step 8: Run browser test and typecheck**

```bash
npx tsc --noEmit -p apps/web/app/tsconfig.json
npm run build:app
node scripts/test-plans-workspace-browser.mjs
```

Expected: PASS in Chromium and WebKit desktop/mobile-width fixture paths used by the script.

- [ ] **Step 9: Commit**

```bash
git add apps/web/app/src/features/plans/hooks/useContinuousPages.ts apps/web/app/src/features/plans/viewer/BlueprintCanvas.tsx apps/web/app/src/features/plans/PlansWorkspace.tsx scripts/test-plans-workspace-browser.mjs
git commit -m "feat(plans): assemble full blueprint workspace"
```

---

### Task 8: Integrate the new workspace into the real Plans controller without changing business semantics

**Files:**
- Modify: `apps/web/app/src/pages/PlansPageContent.tsx`
- Modify: `apps/web/app/src/pages/PlansPage.tsx`
- Modify: `apps/web/app/src/features/plans/inspector/PlanInfoPanel.tsx`
- Modify: `apps/web/app/src/features/plans/PlansWorkspace.tsx`

**Interfaces:**
- Existing handler functions in `PlansPageContent` remain the only implementations of upload, quote/payment, included/paid analysis, consent, rename, download, delete, current-revision selection, and annotation persistence.
- `PlansPage.tsx` still owns pricing-context reads/resolution and the `pageReviewBusy` gate.

- [ ] **Step 1: Replace the old viewer grid with `PlansWorkspace` while leaving existing handlers intact**

Keep the current hooks/effects and pass these values into the workspace:

```tsx
<PlansWorkspace
  projectName={project.name}
  currentRevision={currentRevision}
  previewUrl={previewUrl}
  previewError={previewError}
  isPreviewLoading={isPreviewLoading}
  findings={findings}
  canWrite={canWrite}
  onAnnotationsChange={(annotations) => onUpdateProject({
    ...project,
    revisions: project.revisions.map(revision => revision.id === currentRevision?.id ? { ...revision, annotations } : revision),
  })}
  // action props reference existing handlers; do not duplicate their logic
/>
```

- [ ] **Step 2: Move current Plan Details/Actions presentation into `PlanInfoPanel`**

Wire existing `handleFileUpload`, `handleDownloadOriginal`, `handleDeletePlan`, rename state/save handler, revision-modal controls, selected trades, entitlement notices, included/paid analysis controls, and payment controls as explicit props or composed action content. Do not move their network/business code into feature viewer files.

- [ ] **Step 3: Move Page Review inside the Inspector while retaining `pageReviewBusy` at the wrapper**

`PlansPage.tsx` should pass a page-review config into `PlansPageContent`/workspace instead of rendering PageReview above the Plans content. `onBusyChange={setPageReviewBusy}` still causes the rest of write actions to receive `canWrite && !pageReviewBusy` so concurrent mutations remain blocked.

- [ ] **Step 4: Keep PricingAddressCard outside or above the workspace shell**

Do not merge pricing-address resolution into PDF viewer state. If vertical space becomes excessive, render it as a compact banner above PlansWorkspace, but preserve its existing API flow and 404 trust behavior.

- [ ] **Step 5: Run targeted existing web regressions**

```bash
node --experimental-strip-types --test apps/web/test/ai-consent-ui.test.ts apps/web/test/billing-ui.test.ts apps/web/test/ai-findings-area-report.test.ts apps/web/test/official-persistence.test.ts
npx tsc --noEmit -p apps/web/app/tsconfig.json
npm run build:app
```

Expected: PASS.

- [ ] **Step 6: Run browser regressions that protect business-side behavior**

```bash
node scripts/test-ai-review-browser.mjs
node scripts/test-paid-return-browser.mjs
node scripts/test-page-review-browser.mjs
node scripts/test-plans-workspace-browser.mjs
```

Expected: PASS with no automatic AI/payment calls on reload/open.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/src/pages/PlansPageContent.tsx apps/web/app/src/pages/PlansPage.tsx apps/web/app/src/features/plans
git commit -m "refactor(plans): integrate workspace with existing product controller"
```

---

### Task 9: Retire the old viewer components and make browser verification a PR gate

**Files:**
- Delete: `apps/web/app/src/components/BlueprintViewer.tsx`
- Delete: `apps/web/app/src/components/PageReviewPanel.tsx`
- Modify: `scripts/test-blueprint-browser.mjs`
- Modify: `.github/workflows/durable-ai-plan.yml`

**Interfaces:**
- All live Plans rendering uses `features/plans/PlansWorkspace`.
- Page Review lives at `features/plans/inspector/PageReviewPanel`.

- [ ] **Step 1: Search for legacy component imports and remove the final consumers**

Run:

```bash
grep -R "components/BlueprintViewer\|components/PageReviewPanel" -n apps/web/app/src scripts apps/web/test
```

Expected before cleanup: only legacy test/import references remain. Update them to the new feature paths.

- [ ] **Step 2: Keep the existing PDF browser check useful**

Either convert `scripts/test-blueprint-browser.mjs` to import the new workspace/canvas or reduce it to a low-level render smoke test. It must still prove real PDF worker rendering, production CSS/CSP, page navigation, zoom, note availability, and explicit 404 behavior. Do not duplicate all integrated assertions from `test-plans-workspace-browser.mjs`.

- [ ] **Step 3: Delete old component files and typecheck**

```bash
rm apps/web/app/src/components/BlueprintViewer.tsx apps/web/app/src/components/PageReviewPanel.tsx
npx tsc --noEmit -p apps/web/app/tsconfig.json
```

Expected: PASS and no old imports.

- [ ] **Step 4: Add the new browser verifier to `durable-ai-plan.yml`**

Add after the existing PDF viewer check:

```yaml
      - name: Plans workspace navigation and grounded AI source review
        run: node scripts/test-plans-workspace-browser.mjs
```

Keep the existing `test-page-review-browser.mjs` step unchanged so both integrated workspace behavior and explicit page-review safety are gated.

- [ ] **Step 5: Run the complete verification set locally**

```bash
npm run test:web
npx tsc --noEmit -p apps/web/app/tsconfig.json
npm run build:app
node scripts/test-blueprint-browser.mjs
node scripts/test-plans-workspace-browser.mjs
node scripts/test-ai-review-browser.mjs
node scripts/test-paid-return-browser.mjs
node scripts/test-page-review-browser.mjs
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A apps/web/app/src/components apps/web/app/src/features/plans scripts/test-blueprint-browser.mjs scripts/test-plans-workspace-browser.mjs scripts/test-page-review-browser.mjs .github/workflows/durable-ai-plan.yml
git commit -m "test(plans): gate the new blueprint workspace"
```

---

### Task 10: Final regression, browser evidence, and release-candidate check

**Files:**
- No source file is required solely for this task unless verification exposes a defect.
- Generated screenshots remain under `test-results/` and are uploaded by CI; do not commit them unless the repository already intentionally tracks test evidence.

**Interfaces:**
- Produces a verified commit suitable for PR/review, not a claim that AI takeoff is exhaustive.

- [ ] **Step 1: Run the full repository gates from a clean working tree**

```bash
npm test
npx tsc --noEmit
npx tsc --noEmit -p apps/web/app/tsconfig.json
VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_ci_compile_only_no_access npm run build
```

Expected: PASS.

- [ ] **Step 2: Install the same isolated browser version used by CI if it is not already installed**

```bash
npm install --prefix .browser-tests --no-package-lock --no-audit --no-fund playwright@1.58.2
node .browser-tests/node_modules/playwright/cli.js install chromium webkit
```

- [ ] **Step 3: Run every applicable browser verifier**

```bash
node scripts/test-blueprint-browser.mjs
node scripts/test-plans-workspace-browser.mjs
node scripts/test-ai-review-browser.mjs
node scripts/test-paid-return-browser.mjs
node scripts/test-page-review-browser.mjs
```

Required evidence:
- PDF opens under production CSP;
- sheet thumbnail navigation works;
- toolbar page navigation works;
- zoom / Fit Width / Fit Page work;
- Single and Continuous modes preserve active page;
- Continuous mode keeps the live render window bounded;
- mapped finding navigates to valid source geometry;
- unmapped finding never gets a fabricated marker;
- Notes and layer visibility work;
- Focus Mode exits with Escape;
- opening Plans/Inspector/Page Review causes no metered AI request;
- inventory load causes no page-analysis request;
- explicit page analysis sends one request per unsaved selected page;
- uncertain request is not automatically replayed;
- paid-return recovery does not create an automatic payment or AI job.

- [ ] **Step 4: Confirm no Full Takeoff V2 flag was changed**

```bash
git diff main...HEAD -- .env.example apps/api scripts | grep -E "TAKEOFF_V2_ENABLED|TAKEOFF_V2_WORKER_ENABLED|TAKEOFF_V2_CLAUDE_ENABLED" || true
```

Expected: no change enabling any flag to `true` as part of this frontend work.

- [ ] **Step 5: Inspect diff scope**

```bash
git status --short
git diff --stat main...HEAD
git diff main...HEAD -- apps/web/app/src/pages/PlansPage.tsx apps/web/app/src/pages/PlansPageContent.tsx apps/web/app/src/features/plans scripts/test-page-review-browser.mjs scripts/test-plans-workspace-browser.mjs .github/workflows/durable-ai-plan.yml
```

Reject unrelated backend/provider/pricing changes before PR.

- [ ] **Step 6: Commit only if verification required a final fix**

```bash
git add <only-the-files-corrected-by-verification>
git commit -m "fix(plans): resolve final workspace regression"
```

If no file changed, do not create an empty commit.

---

## Implementation Review Checklist

Before opening the PR, verify each spec requirement maps to a completed task:

- Full-height workspace and blueprint dominance: Tasks 7-8.
- Thumbnail/sheet primary navigation: Task 4 + Task 7 browser checks.
- Single/Continuous modes with bounded rendering: Task 1 + Task 7.
- Zoom, Fit Width, Fit Page, actual size, pan, Focus Mode: Task 3 + Task 7.
- Findings removed from above the PDF and moved to Inspector: Tasks 5 + 8.
- Grounded Fly To and unmapped honesty: Tasks 1 + 6 + browser checks.
- Takeoff/Notes/Plan inspector tabs: Task 5.
- Existing plan actions and AI/billing semantics preserved: Task 8.
- Owner Page Review moved but no automatic/replayed requests: Task 5 + Task 8 + Task 10.
- Legacy monolithic viewer removed only after parity: Task 9.
- Existing and new unit/build/browser gates: Tasks 9-10.

## Completion Rule

Do not mark Plans Workspace V2 complete because TypeScript compiles or Vite builds. Completion requires the real integrated browser harness to prove PDF navigation, source-grounded finding review, panel/focus interactions, continuous-mode bounded rendering, and the P0 no-automatic-page-analysis/no-replay invariant while existing AI/payment recovery regressions remain green.
