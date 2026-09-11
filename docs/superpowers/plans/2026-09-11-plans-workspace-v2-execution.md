# RoughBid Plans Workspace V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the RoughBid Plans screen into a full-height blueprint workspace with primary sheet navigation, a larger PDF reader, Single/Continuous modes, grounded AI finding navigation, inspector panels, focus mode, and unchanged billing/entitlement/page-review safety semantics.

**Architecture:** `PlansPageContent.tsx` stays the business controller for upload, preview URL, entitlements, billing, consent, AI jobs, and revision mutations. Viewer-only behavior moves to `apps/web/app/src/features/plans/**`. The new workspace composes a sheet navigator, a PDF.js canvas, and an inspector; pure geometry/viewport helpers are unit-tested, and browser behavior is verified with the repository's existing synthetic Playwright pattern.

**Tech Stack:** React 19, TypeScript 5.8, Vite 6, Tailwind CSS 4, `pdfjs-dist` 6.3.289, `lucide-react`, Node `node:test`, `pdf-lib`, Playwright 1.58.2.

**Spec:** `docs/superpowers/specs/2026-09-11-plans-workspace-v2-design.md`

## Global Constraints

- The blueprint is the dominant visual surface.
- `PlansPageContent.tsx` remains authoritative for upload, private preview URL creation, entitlement checks, saved quote/payment recovery, AI consent, included/paid reading start, revision actions, and persisted project updates.
- `PlansPage.tsx` remains authoritative for pricing-context resolution and the `pageReviewBusy` write lock.
- Frontend backend requests continue through `apps/web/app/src/services/api.ts`.
- Do not change provider prompts/models, Stripe pricing/payment semantics, workspace entitlements, storage semantics, or AI-consent semantics.
- Do not enable any closed `TAKEOFF_V2_*` feature flag.
- Opening Plans, switching pages/view modes, opening the AI inspector, or opening Page Review must not start a metered AI request.
- Loading Page Review inventory is read-only.
- Physical-page analysis is explicit; already-saved jobs are skipped; uncertain requests are reconciled and never silently replayed.
- Invalid or absent AI geometry stays unmapped. The browser never invents coordinates or source pages.
- Processed pages never imply exhaustive takeoff completeness.
- No new global state-management library and no replacement PDF SDK.
- UI-only zoom/panel/focus state is not persisted as project business data.
- No secrets are committed.

## File Map

**Create**
- `apps/web/app/src/features/plans/types.ts`
- `apps/web/app/src/features/plans/utils/findingGeometry.ts`
- `apps/web/app/src/features/plans/utils/viewport.ts`
- `apps/web/app/src/features/plans/hooks/usePdfDocument.ts`
- `apps/web/app/src/features/plans/hooks/useBlueprintViewport.ts`
- `apps/web/app/src/features/plans/hooks/useContinuousPages.ts`
- `apps/web/app/src/features/plans/hooks/useFindingNavigation.ts`
- `apps/web/app/src/features/plans/viewer/BlueprintPage.tsx`
- `apps/web/app/src/features/plans/viewer/FindingOverlay.tsx`
- `apps/web/app/src/features/plans/viewer/AnnotationOverlay.tsx`
- `apps/web/app/src/features/plans/viewer/BlueprintToolbar.tsx`
- `apps/web/app/src/features/plans/viewer/BlueprintCanvas.tsx`
- `apps/web/app/src/features/plans/sheets/SheetThumbnail.tsx`
- `apps/web/app/src/features/plans/sheets/SheetNavigator.tsx`
- `apps/web/app/src/features/plans/inspector/FindingsPanel.tsx`
- `apps/web/app/src/features/plans/inspector/TakeoffPanel.tsx`
- `apps/web/app/src/features/plans/inspector/NotesPanel.tsx`
- `apps/web/app/src/features/plans/inspector/PlanInfoPanel.tsx`
- `apps/web/app/src/features/plans/inspector/PageReviewPanel.tsx`
- `apps/web/app/src/features/plans/inspector/PlanInspector.tsx`
- `apps/web/app/src/features/plans/PlansWorkspace.tsx`
- `apps/web/test/plans-finding-geometry.test.ts`
- `apps/web/test/plans-viewport.test.ts`
- `scripts/test-plans-workspace-browser.mjs`

**Modify**
- `apps/web/app/src/pages/PlansPageContent.tsx`
- `apps/web/app/src/pages/PlansPage.tsx`
- `scripts/test-blueprint-browser.mjs`
- `scripts/test-page-review-browser.mjs`
- `.github/workflows/durable-ai-plan.yml`

**Delete only after parity passes**
- `apps/web/app/src/components/BlueprintViewer.tsx`
- `apps/web/app/src/components/PageReviewPanel.tsx`

---

### Task 1: Lock geometry and viewport contracts with pure tests

**Files:**
- Create: `apps/web/app/src/features/plans/types.ts`
- Create: `apps/web/app/src/features/plans/utils/findingGeometry.ts`
- Create: `apps/web/app/src/features/plans/utils/viewport.ts`
- Create: `apps/web/test/plans-finding-geometry.test.ts`
- Create: `apps/web/test/plans-viewport.test.ts`

**Interfaces:**
- Consumes: `PlanReadingFinding` from `apps/web/app/src/services/api.ts`.
- Produces: `getValidFindingBox`, `getValidFindingPoint`, `getFindingTarget`, `clampZoom`, `computeFitWidthZoom`, `computeFitPageZoom`, `computeBoxFocusZoom`, `getContinuousRenderWindow`, `pickActivePage`.

- [ ] **Step 1: Add failing geometry tests**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PlanReadingFinding } from '../app/src/services/api.ts';
import { getFindingTarget, getValidFindingBox, getValidFindingPoint } from '../app/src/features/plans/utils/findingGeometry.ts';

const makeFinding = (geometry: Record<string, unknown>, page_number: number | null = 3): PlanReadingFinding => ({
  id: 'f', page_number, finding_type: 'material', label: 'Wall', value_text: null,
  quantity: null, unit: null, confidence: 0.9, geometry, source_excerpt: 'source', status: 'needs_review',
});

test('accepts only normalized in-page boxes', () => {
  assert.deepEqual(getValidFindingBox(makeFinding({ bbox: [0.1, 0.2, 0.3, 0.4] })), [0.1, 0.2, 0.3, 0.4]);
  assert.equal(getValidFindingBox(makeFinding({ bbox: [0.9, 0.2, 0.3, 0.4] })), null);
  assert.equal(getValidFindingBox(makeFinding({ bbox: [-0.1, 0.2, 0.3, 0.4] })), null);
});

test('bbox center wins over point and geometry-free finding remains page-only', () => {
  assert.deepEqual(getValidFindingPoint(makeFinding({ bbox: [0.2, 0.2, 0.2, 0.2], point: [0.9, 0.9] })), { x: 0.3, y: 0.3 });
  assert.deepEqual(getFindingTarget(makeFinding({}), 10), { kind: 'page', page: 3 });
  assert.deepEqual(getFindingTarget(makeFinding({ point: [0.5, 0.25] }), 10), { kind: 'point', page: 3, point: { x: 0.5, y: 0.25 } });
  assert.equal(getFindingTarget(makeFinding({ point: [0.5, 0.25] }, 99), 10), null);
});
```

- [ ] **Step 2: Add failing viewport tests**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { clampZoom, computeBoxFocusZoom, computeFitPageZoom, computeFitWidthZoom, getContinuousRenderWindow, pickActivePage } from '../app/src/features/plans/utils/viewport.ts';

test('zoom clamps to 25-500 percent', () => {
  assert.equal(clampZoom(5), 25);
  assert.equal(clampZoom(125), 125);
  assert.equal(clampZoom(900), 500);
});

test('fit calculations use total viewport padding', () => {
  assert.equal(computeFitWidthZoom({ pageWidth: 1000, viewportWidth: 800, totalHorizontalPadding: 40 }), 76);
  assert.equal(computeFitPageZoom({ pageWidth: 1000, pageHeight: 800, viewportWidth: 800, viewportHeight: 600, totalHorizontalPadding: 40, totalVerticalPadding: 40 }), 70);
});

test('box focus targets 72 percent of viewport and clamps', () => {
  assert.equal(computeBoxFocusZoom({ boxWidth: 0.5, boxHeight: 0.5, currentZoom: 100 }), 144);
  assert.equal(computeBoxFocusZoom({ boxWidth: 0.01, boxHeight: 0.01, currentZoom: 100 }), 500);
});

test('continuous render window is bounded around active page', () => {
  assert.deepEqual(getContinuousRenderWindow({ activePage: 10, totalPages: 50, radius: 2 }), [8, 9, 10, 11, 12]);
  assert.deepEqual(getContinuousRenderWindow({ activePage: 1, totalPages: 3, radius: 2 }), [1, 2, 3]);
});

test('largest intersection ratio selects active page', () => {
  assert.equal(pickActivePage([{ page: 4, ratio: 0.2 }, { page: 5, ratio: 0.8 }, { page: 6, ratio: 0.3 }]), 5);
});
```

- [ ] **Step 3: Run tests and verify red state**

```bash
node --experimental-strip-types --test apps/web/test/plans-finding-geometry.test.ts apps/web/test/plans-viewport.test.ts
```

Expected: FAIL because the new utility modules do not exist.

- [ ] **Step 4: Implement exact utility contracts**

`types.ts`:

```ts
export type PlansViewMode = 'single' | 'continuous';
export type PlansFitMode = 'manual' | 'width' | 'page';
export type PlansInspectorTab = 'ai' | 'takeoff' | 'notes' | 'plan';
export type NormalizedBox = readonly [number, number, number, number];
export type NormalizedPoint = Readonly<{ x: number; y: number }>;
export type FindingTarget =
  | { kind: 'box'; page: number; box: NormalizedBox }
  | { kind: 'point'; page: number; point: NormalizedPoint }
  | { kind: 'page'; page: number };
```

`viewport.ts` formulas:

```ts
export const clampZoom = (percent: number) => Math.min(500, Math.max(25, Math.round(percent)));

export function computeFitWidthZoom(input: { pageWidth: number; viewportWidth: number; totalHorizontalPadding: number }) {
  return clampZoom(((input.viewportWidth - input.totalHorizontalPadding) / input.pageWidth) * 100);
}

export function computeFitPageZoom(input: { pageWidth: number; pageHeight: number; viewportWidth: number; viewportHeight: number; totalHorizontalPadding: number; totalVerticalPadding: number }) {
  const widthScale = (input.viewportWidth - input.totalHorizontalPadding) / input.pageWidth;
  const heightScale = (input.viewportHeight - input.totalVerticalPadding) / input.pageHeight;
  return clampZoom(Math.min(widthScale, heightScale) * 100);
}

export function computeBoxFocusZoom(input: { boxWidth: number; boxHeight: number; currentZoom: number }) {
  if (input.boxWidth <= 0 || input.boxHeight <= 0) return clampZoom(input.currentZoom);
  return clampZoom(Math.min(0.72 / input.boxWidth, 0.72 / input.boxHeight) * 100);
}
```

`findingGeometry.ts` must reject non-arrays, non-finite numbers, negative values, zero-size boxes, boxes extending past 1.0, points outside 0..1, null/zero/out-of-range page numbers. Bbox center takes precedence over a supplied point.

- [ ] **Step 5: Run green tests and typecheck**

```bash
node --experimental-strip-types --test apps/web/test/plans-finding-geometry.test.ts apps/web/test/plans-viewport.test.ts
npx tsc --noEmit -p apps/web/app/tsconfig.json
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/src/features/plans/types.ts apps/web/app/src/features/plans/utils/findingGeometry.ts apps/web/app/src/features/plans/utils/viewport.ts apps/web/test/plans-finding-geometry.test.ts apps/web/test/plans-viewport.test.ts
git commit -m "feat(plans): add geometry and viewport contracts"
```

---

### Task 2: Extract PDF document loading and cancelable page rendering

**Files:**
- Create: `apps/web/app/src/features/plans/hooks/usePdfDocument.ts`
- Create: `apps/web/app/src/features/plans/viewer/BlueprintPage.tsx`
- Create: `apps/web/app/src/features/plans/viewer/FindingOverlay.tsx`
- Create: `apps/web/app/src/features/plans/viewer/AnnotationOverlay.tsx`

**Interfaces:**
- `usePdfDocument(previewUrl)` -> `{ pdf, status, error }`.
- `BlueprintPage` renders one physical page and calls `onPageMetrics(pageNumber, { width, height })` after reading base page dimensions.
- Overlays receive normalized source data and never call backend APIs.

- [ ] **Step 1: Implement `usePdfDocument` using the current PDF.js worker**

```ts
import { useEffect, useState } from 'react';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type PdfDocumentState = {
  pdf: pdfjs.PDFDocumentProxy | null;
  status: 'idle' | 'loading' | 'ready' | 'failed';
  error: string | null;
};

export function usePdfDocument(previewUrl: string | null | undefined): PdfDocumentState {
  const [state, setState] = useState<PdfDocumentState>({ pdf: null, status: previewUrl ? 'loading' : 'idle', error: null });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let loadingTask: ReturnType<typeof pdfjs.getDocument> | undefined;
    setState({ pdf: null, status: previewUrl ? 'loading' : 'idle', error: null });
    if (!previewUrl) return () => controller.abort();

    void (async () => {
      try {
        const response = await fetch(previewUrl, { signal: controller.signal });
        if (!response.ok) throw new Error(`Unable to open this PDF (${response.status}).`);
        const data = await response.arrayBuffer();
        if (cancelled) return;
        loadingTask = pdfjs.getDocument({ data });
        const pdf = await loadingTask.promise;
        if (!cancelled) setState({ pdf, status: 'ready', error: null });
      } catch (error) {
        if (!cancelled) setState({ pdf: null, status: 'failed', error: error instanceof Error ? error.message : 'Unable to open this PDF.' });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      void loadingTask?.destroy();
    };
  }, [previewUrl]);

  return state;
}
```

- [ ] **Step 2: Implement `BlueprintPage` with detached-canvas rendering**

Use `pdf.getPage(pageNumber)`, get a base viewport at scale 1, calculate CSS scale from `zoomPercent / 100`, cap device pixel ratio at 2, render into a detached staging canvas, then copy to the visible canvas only if the effect is still current. Cleanup calls `renderTask.cancel()`.

The visible canvas aria-label is exactly:

```tsx
aria-label={`Uploaded PDF: ${fileName}, page ${pageNumber}`}
```

- [ ] **Step 3: Implement overlays**

`FindingOverlay` calls `getValidFindingBox` and `getValidFindingPoint`. It renders no marker or box for invalid geometry. `AnnotationOverlay` uses only persisted `PlanAnnotation.page/x/y/text` values and filters to the rendered page.

- [ ] **Step 4: Verify build boundary**

```bash
npx tsc --noEmit -p apps/web/app/tsconfig.json
npm run build:app
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/src/features/plans/hooks/usePdfDocument.ts apps/web/app/src/features/plans/viewer/BlueprintPage.tsx apps/web/app/src/features/plans/viewer/FindingOverlay.tsx apps/web/app/src/features/plans/viewer/AnnotationOverlay.tsx
git commit -m "feat(plans): extract PDF rendering primitives"
```

---

### Task 3: Add professional viewport controls and toolbar

**Files:**
- Create: `apps/web/app/src/features/plans/hooks/useBlueprintViewport.ts`
- Create: `apps/web/app/src/features/plans/viewer/BlueprintToolbar.tsx`
- Modify: `apps/web/app/src/features/plans/types.ts`

**Interfaces:**
- `useBlueprintViewport` owns zoom/fit/pan input state only.
- Toolbar contains no API calls.

- [ ] **Step 1: Implement viewport state contract**

```ts
export type BlueprintViewportController = {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  zoomPercent: number;
  fitMode: PlansFitMode;
  handTool: boolean;
  isPanning: boolean;
  setManualZoom: (percent: number) => void;
  setFitMode: (mode: PlansFitMode) => void;
  setHandTool: (active: boolean) => void;
};
```

Use `ResizeObserver` to recalculate zoom when Fit Width or Fit Page is active and the canvas viewport changes size. Manual zoom always changes fit mode to `manual`.

- [ ] **Step 2: Add pointer-centered wheel zoom**

On `ctrlKey || metaKey`, prevent the browser zoom for the viewer event, calculate `nextZoom = clampZoom(current + (deltaY < 0 ? 10 : -10))`, preserve the point beneath the cursor using old/new scale ratio, and update `scrollLeft/scrollTop` after the render size changes. Plain wheel remains normal scrolling.

- [ ] **Step 3: Add pan rules**

Primary-button drag pans only when Hand is active or Space is held. Middle-button drag also pans. Store the starting pointer and starting scroll offsets. Set `isPanning` during movement so note placement is blocked.

- [ ] **Step 4: Build toolbar with fixed accessible names**

Required names: `Previous PDF page`, `Next PDF page`, `PDF page`, `Zoom out`, `Zoom in`, `Fit width`, `Fit page`, `Actual size`, `Hand tool`, `Layers`, `Add note`, `View mode`, `Focus mode`.

Page selector remains a secondary control and lists physical pages 1..`pdf.numPages`.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit -p apps/web/app/tsconfig.json
git add apps/web/app/src/features/plans/hooks/useBlueprintViewport.ts apps/web/app/src/features/plans/viewer/BlueprintToolbar.tsx apps/web/app/src/features/plans/types.ts
git commit -m "feat(plans): add blueprint viewport controls"
```

---

### Task 4: Build Sheet Navigator with lazy low-resolution thumbnails

**Files:**
- Create: `apps/web/app/src/features/plans/sheets/SheetThumbnail.tsx`
- Create: `apps/web/app/src/features/plans/sheets/SheetNavigator.tsx`
- Modify: `apps/web/app/src/features/plans/types.ts`

**Interfaces:**
- `SheetNavigator({ pdf, activePage, onSelectPage, pageReviewInventory })` is read-only with respect to backend state.
- `SheetThumbnail` receives `pdf` + `pageNumber` and returns a low-resolution canvas.

- [ ] **Step 1: Add sheet label type and fallback**

```ts
export type PlanSheet = { page: number; label: string; title?: string };
export const fallbackSheetLabel = (page: number) => `Page ${String(page).padStart(2, '0')}`;
```

Do not display architectural labels such as `A1.0` unless they are supplied by trusted document/result metadata.

- [ ] **Step 2: Implement thumbnail render**

Use a target CSS width of 140 px, `page.getViewport({ scale: 1 })`, scale to 140/baseWidth, and a DPR cap of 1.5. Cancel the render task on unmount/page change.

- [ ] **Step 3: Implement navigation behavior**

Render a search input named `Search sheets`, a button for each visible physical page with `aria-label="Open PDF page N"`, and active state via `aria-current="page"`. ArrowUp/ArrowDown moves between pages only when focus is on sheet entries, not while typing in the search box.

- [ ] **Step 4: Add read-only page-review badges**

When already-loaded inventory is supplied, show `Reviewed`, `Needs attention`, `In progress`, or `Not started` from the matching `pageNumber`. The navigator does not import `getPageReviewInventory` or `startPhysicalPageReading`.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit -p apps/web/app/tsconfig.json
git add apps/web/app/src/features/plans/sheets/SheetThumbnail.tsx apps/web/app/src/features/plans/sheets/SheetNavigator.tsx apps/web/app/src/features/plans/types.ts
git commit -m "feat(plans): add sheet navigator"
```

---

### Task 5: Build Inspector panels and migrate owner Page Review unchanged semantically

**Files:**
- Create: `apps/web/app/src/features/plans/inspector/FindingsPanel.tsx`
- Create: `apps/web/app/src/features/plans/inspector/TakeoffPanel.tsx`
- Create: `apps/web/app/src/features/plans/inspector/NotesPanel.tsx`
- Create: `apps/web/app/src/features/plans/inspector/PlanInfoPanel.tsx`
- Create: `apps/web/app/src/features/plans/inspector/PageReviewPanel.tsx`
- Create: `apps/web/app/src/features/plans/inspector/PlanInspector.tsx`
- Modify: `scripts/test-page-review-browser.mjs`

**Interfaces:**
- FindingsPanel: `findings`, `selectedFindingId`, `onSelectFinding`.
- TakeoffPanel: `findings`, `onSelectFinding`; grouping uses existing `groupAiFindingsByArea`.
- NotesPanel: `annotations`, `selectedAnnotationId`, `onSelectAnnotation`.
- PageReviewPanel keeps current public props: `workspaceId`, `projectId`, `fileId`, `scope`, `canWrite`, `onBusyChange`, `onOpenJob`.
- PlanInfoPanel receives existing action callbacks; it never calls backend services itself.

- [ ] **Step 1: Move Page Review code to the feature path without altering request sequence**

The run loop remains:

```ts
const existing = inventory.pages.find(page => page.pageNumber === number);
if (!existing || existing.jobId) continue;
const job = await startPhysicalPageReading(props.workspaceId, props.projectId, inventory, number);
```

Failure reconciliation remains:

```ts
try {
  const result = await getPageReviewInventory(props.workspaceId, props.projectId, props.fileId, props.scope, TRADES);
  if (current.current === key) setInventory(result);
} catch {
  setNotice('Saved status could not be reloaded. Reload before another attempt.');
  setInventory(null);
}
```

There is no automatic second `startPhysicalPageReading` call.

- [ ] **Step 2: Update and run P0 browser regression**

In `scripts/test-page-review-browser.mjs`, change the fixture import to:

```tsx
import { PageReviewPanel } from '../apps/web/app/src/features/plans/inspector/PageReviewPanel';
```

Change the Vite stub resolver's importer check to the new feature path. Keep the existing synthetic assertions: inventory load yields no page-analysis calls, double-clicking Analyze Remaining yields `[2,3]`, saved page 1 is skipped, failure yields only `[2]`, and customer query hides the owner panel.

Run:

```bash
node scripts/test-page-review-browser.mjs
```

Expected: PASS.

- [ ] **Step 3: Build Findings and Takeoff panels**

Findings excludes `status === 'rejected'` from the normal list, supports search + finding type filter, shows confidence and page, and labels geometry state `Mapped` or `Unmapped`. Takeoff calls `groupAiFindingsByArea(findings)` and displays existing quantity/unit plus `Costs not configured` when source pricing is absent; it does not derive new prices or measurements.

- [ ] **Step 4: Build Notes and Plan Info panels**

Notes lists all persisted annotations with physical page number. Plan Info receives props for file metadata, revision history, rename, upload, download, delete, selected trades, entitlement state, quote/payment controls, included/paid analysis controls, and AI-consent controls; the implementations of those operations remain in `PlansPageContent.tsx`.

- [ ] **Step 5: Build accessible Inspector tabs**

Top-level tabs are `AI`, `Takeoff`, `Notes`, `Plan`. AI contains `Findings` and `Page Review` subviews when page-review props exist. Tab changes are local React state only.

- [ ] **Step 6: Verify and commit**

```bash
npx tsc --noEmit -p apps/web/app/tsconfig.json
node scripts/test-page-review-browser.mjs
git add apps/web/app/src/features/plans/inspector scripts/test-page-review-browser.mjs
git commit -m "feat(plans): add contextual plan inspector"
```

---

### Task 6: Add grounded Fly To navigation and layer visibility

**Files:**
- Create: `apps/web/app/src/features/plans/hooks/useFindingNavigation.ts`
- Modify: `apps/web/app/src/features/plans/viewer/FindingOverlay.tsx`
- Modify: `apps/web/app/src/features/plans/inspector/FindingsPanel.tsx`

**Interfaces:**
- `focusFinding(finding)` consumes only `getFindingTarget(finding, pdfPageCount)`.

- [ ] **Step 1: Implement finding navigation contract**

`useFindingNavigation` receives setters for active page and manual zoom plus DOM getters for the page element and scroll container. Behavior is exact:

```ts
const target = getFindingTarget(finding, pdfPageCount);
if (!target) return;
setActivePage(target.page);
setSelectedFindingId(finding.id);
if (target.kind === 'box') setManualZoom(computeBoxFocusZoom({ boxWidth: target.box[2], boxHeight: target.box[3], currentZoom }));
```

After the target page element is mounted/rendered, center the normalized box center or point in the scroll container. For `kind === 'page'`, navigate to the page and leave geometry unrendered.

- [ ] **Step 2: Implement layer semantics**

Layer state contains `showAiMarkers`, `showFindingHighlights`, `showManualNotes`. Default markers are visible; non-selected boxes are subdued/hidden according to `showFindingHighlights`; selected source geometry has strong emphasis. Risk findings retain a text/icon distinction in addition to color.

- [ ] **Step 3: Verify pure contracts**

```bash
node --experimental-strip-types --test apps/web/test/plans-finding-geometry.test.ts apps/web/test/plans-viewport.test.ts
npx tsc --noEmit -p apps/web/app/tsconfig.json
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/src/features/plans/hooks/useFindingNavigation.ts apps/web/app/src/features/plans/viewer/FindingOverlay.tsx apps/web/app/src/features/plans/inspector/FindingsPanel.tsx
git commit -m "feat(plans): add grounded finding navigation"
```

---

### Task 7: Assemble BlueprintCanvas and full PlansWorkspace, including Continuous and Focus modes

**Files:**
- Create: `apps/web/app/src/features/plans/hooks/useContinuousPages.ts`
- Create: `apps/web/app/src/features/plans/viewer/BlueprintCanvas.tsx`
- Create: `apps/web/app/src/features/plans/PlansWorkspace.tsx`
- Create: `scripts/test-plans-workspace-browser.mjs`

**Interfaces:**
- `PlansWorkspace` receives project/revision/preview/findings/canWrite state and explicit callbacks from the page controller.
- `BlueprintCanvas` has no imports from `services/api.ts`.

- [ ] **Step 1: Write the failing synthetic workspace browser harness**

Create a 23-page `pdf-lib` fixture and three findings:

```ts
const findings = [
  { id:'mapped-box', page_number:3, finding_type:'material', label:'Exterior wall', value_text:null, quantity:40, unit:'LF', confidence:.95, geometry:{bbox:[.2,.2,.2,.2]}, source_excerpt:'Exterior bearing wall', status:'needs_review' },
  { id:'mapped-point', page_number:5, finding_type:'risk', label:'Header check', value_text:null, quantity:null, unit:null, confidence:.72, geometry:{point:[.6,.4]}, source_excerpt:'Verify header', status:'needs_review' },
  { id:'unmapped', page_number:7, finding_type:'scope_note', label:'General note', value_text:'Review', quantity:null, unit:null, confidence:.8, geometry:{}, source_excerpt:'General note', status:'needs_review' },
];
```

The fixture imports `PlansWorkspace`, supplies a local object URL from `/sample.pdf`, a current revision, the findings above, and an in-memory `annotations` state callback. Assertions require:
- region `Synthetic Plans workspace` visible;
- 23 `Open PDF page N` buttons on desktop;
- selecting page 23 changes the visible canvas aria-label to `page 23`;
- selecting `Exterior wall` changes active page to 3 and shows mapped source emphasis;
- selecting `General note` changes active page to 7 and no marker with aria-label `AI marker: General note` exists;
- `View mode` can switch to Continuous and back while preserving active page;
- the number of visible full-resolution page canvases in Continuous stays at or below 5;
- `Focus mode` hides Sheets and Inspector; Escape restores them;
- broken preview produces `Unable to open this PDF (404)` and no page crash.

Run:

```bash
npm run build:app
node scripts/test-plans-workspace-browser.mjs
```

Expected before implementation: FAIL because `PlansWorkspace` does not exist.

- [ ] **Step 2: Implement `useContinuousPages`**

Use `IntersectionObserver` with the canvas scroll root. Track ratios in a `Map<number, number>`, calculate active page with `pickActivePage`, and derive mounted render pages from `getContinuousRenderWindow({ activePage, totalPages, radius: 2 })`. Distant pages render aspect-ratio placeholders only.

- [ ] **Step 3: Implement `BlueprintCanvas`**

Single mode mounts one `BlueprintPage`. Continuous mode maps all page placeholders but mounts `BlueprintPage` only for the bounded render set. `BlueprintCanvas` owns the scroll container, viewport controller, note placement, layer popover state, and toolbar. It does not own upload, payment, consent, or AI-start actions.

- [ ] **Step 4: Implement manual note creation**

A click creates a pending point only when `canWrite && noteMode && !isPanning && renderReady`. On save:

```ts
const note: PlanAnnotation = {
  id: crypto.randomUUID(),
  page: activePage,
  x: pendingPoint.x,
  y: pendingPoint.y,
  text: noteText.trim().slice(0, 500),
};
onAnnotationsChange([...annotations, note]);
```

- [ ] **Step 5: Implement `PlansWorkspace` full-height shell**

Desktop uses three columns with target widths `220px minmax(0,1fr) 360px`. Remove the old centered `max-w-6xl` constraint. Both side panels collapse independently; under the narrow breakpoint they become overlay drawers. Focus mode renders the workspace as a fixed high-z-index overlay, hides Sheets/Inspector, retains the toolbar, and exits on Escape.

- [ ] **Step 6: Run browser/typecheck gates**

```bash
npx tsc --noEmit -p apps/web/app/tsconfig.json
npm run build:app
node scripts/test-plans-workspace-browser.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/src/features/plans/hooks/useContinuousPages.ts apps/web/app/src/features/plans/viewer/BlueprintCanvas.tsx apps/web/app/src/features/plans/PlansWorkspace.tsx scripts/test-plans-workspace-browser.mjs
git commit -m "feat(plans): assemble blueprint workspace"
```

---

### Task 8: Integrate the workspace with the real Plans business controller

**Files:**
- Modify: `apps/web/app/src/pages/PlansPageContent.tsx`
- Modify: `apps/web/app/src/pages/PlansPage.tsx`
- Modify: `apps/web/app/src/features/plans/PlansWorkspace.tsx`
- Modify: `apps/web/app/src/features/plans/inspector/PlanInfoPanel.tsx`

**Interfaces:**
- Existing `PlansPageContent` handler functions remain the only implementations of business mutations.
- Page Review retains `onBusyChange={setPageReviewBusy}` so other write controls receive the existing lock.

- [ ] **Step 1: Replace the old viewer/dashboard grid with `PlansWorkspace`**

Keep existing hooks/effects/handlers unchanged, then pass current data and callbacks. The annotation callback remains:

```tsx
onAnnotationsChange={(annotations) => onUpdateProject({
  ...project,
  revisions: project.revisions.map(revision => revision.id === currentRevision?.id ? { ...revision, annotations } : revision),
})}
```

Pass explicit Plan Info callbacks that point to existing handlers: `handleFileUpload`, `handleDownloadOriginal`, `handleDeletePlan`, `handleSaveRename`, `handleSetCurrentRevision`, `handleStartFreeReading`, `handleStartAiReading`, `handlePay`, `handleRecalculateQuote`, `refreshSavedQuote`, `handleGrantAiConsent`, plus setters for revision modal and rename UI state.

- [ ] **Step 2: Move Page Review presentation from `PlansPage.tsx` into Inspector**

`PlansPage.tsx` stops rendering the standalone PageReview block. It passes this config to `PlansPageContent`:

```ts
{
  workspaceId,
  projectId: project.remoteId,
  fileId: currentRevision.remoteFileId,
  scope: project.projectType,
  canWrite,
  onBusyChange: setPageReviewBusy,
  onOpenJob: (jobId, status) => {
    props.onPatchRevision(currentRevision.id, { aiPlanJobId: jobId, aiPlanStatus: status });
    props.onOpenAIAssistant();
  },
}
```

The surrounding controller still supplies `canWrite={canWrite && !pageReviewBusy}` to mutation controls outside the active PageReview request.

- [ ] **Step 3: Preserve PricingAddressCard as a separate trust component**

Keep `getPricingContext`, `resolvePricingAddress`, stale-request guard, and 404 handling in `PlansPage.tsx`. Render the card as a compact banner immediately above the full-height workspace rather than moving its API behavior into viewer state.

- [ ] **Step 4: Run business regressions**

```bash
node --experimental-strip-types --test apps/web/test/ai-consent-ui.test.ts apps/web/test/billing-ui.test.ts apps/web/test/ai-findings-area-report.test.ts apps/web/test/official-persistence.test.ts
npx tsc --noEmit -p apps/web/app/tsconfig.json
npm run build:app
node scripts/test-ai-review-browser.mjs
node scripts/test-paid-return-browser.mjs
node scripts/test-page-review-browser.mjs
node scripts/test-plans-workspace-browser.mjs
```

Expected: PASS, with no automatic AI/payment request from opening/reloading Plans.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/src/pages/PlansPageContent.tsx apps/web/app/src/pages/PlansPage.tsx apps/web/app/src/features/plans/PlansWorkspace.tsx apps/web/app/src/features/plans/inspector/PlanInfoPanel.tsx
git commit -m "refactor(plans): connect workspace to product controller"
```

---

### Task 9: Retire legacy components, update browser gates, and verify release candidate

**Files:**
- Delete: `apps/web/app/src/components/BlueprintViewer.tsx`
- Delete: `apps/web/app/src/components/PageReviewPanel.tsx`
- Modify: `scripts/test-blueprint-browser.mjs`
- Modify: `.github/workflows/durable-ai-plan.yml`

**Interfaces:**
- Live Plans UI uses only `features/plans/PlansWorkspace`.
- Page Review uses only `features/plans/inspector/PageReviewPanel`.

- [ ] **Step 1: Convert the existing blueprint browser verifier to a low-level new-canvas smoke test**

Replace its `BlueprintViewer` fixture import with `BlueprintCanvas` and provide a local PDF document through `usePdfDocument`. Keep assertions for: production CSS loaded, 23 physical pages available through the secondary page selector, page 23 renders, Zoom In increases canvas bitmap width, Add Note is enabled after render, and a 404 preview shows the explicit error. The integrated layout/Inspector/Continuous assertions stay in `test-plans-workspace-browser.mjs`.

- [ ] **Step 2: Confirm no legacy imports remain, then delete old files**

```bash
grep -R "components/BlueprintViewer\|components/PageReviewPanel" -n apps/web/app/src scripts apps/web/test || true
```

Expected after updating browser imports: no output.

Then:

```bash
rm apps/web/app/src/components/BlueprintViewer.tsx
rm apps/web/app/src/components/PageReviewPanel.tsx
npx tsc --noEmit -p apps/web/app/tsconfig.json
```

Expected: PASS.

- [ ] **Step 3: Add workspace browser gate to durable workflow**

Add exactly after `Desktop and mobile PDF viewer under production CSP`:

```yaml
      - name: Plans workspace navigation and grounded AI source review
        run: node scripts/test-plans-workspace-browser.mjs
```

Keep `Physical page review and safe resume browser checks` unchanged.

- [ ] **Step 4: Run the complete local gate**

```bash
npm run test:web
npx tsc --noEmit
npx tsc --noEmit -p apps/web/app/tsconfig.json
VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_ci_compile_only_no_access npm run build
node scripts/test-blueprint-browser.mjs
node scripts/test-plans-workspace-browser.mjs
node scripts/test-ai-review-browser.mjs
node scripts/test-paid-return-browser.mjs
node scripts/test-page-review-browser.mjs
```

Required result: every command exits 0.

- [ ] **Step 5: Verify no closed Full Takeoff V2 feature was enabled**

```bash
git diff main...HEAD -- .env.example apps/api scripts | grep -E "^\+.*TAKEOFF_V2_(ENABLED|WORKER_ENABLED|CLAUDE_ENABLED)=true" && exit 1 || true
```

Expected: no matching added line.

- [ ] **Step 6: Inspect scope and working tree**

```bash
git status --short
git diff --stat main...HEAD
git diff main...HEAD -- apps/web/app/src/pages/PlansPage.tsx apps/web/app/src/pages/PlansPageContent.tsx apps/web/app/src/features/plans scripts/test-blueprint-browser.mjs scripts/test-plans-workspace-browser.mjs scripts/test-page-review-browser.mjs .github/workflows/durable-ai-plan.yml
```

Reject changes outside the approved frontend/test scope unless they are necessary compile fixes directly caused by the refactor.

- [ ] **Step 7: Commit the cleanup/gate changes**

```bash
git add -A apps/web/app/src/components apps/web/app/src/features/plans scripts/test-blueprint-browser.mjs scripts/test-plans-workspace-browser.mjs scripts/test-page-review-browser.mjs .github/workflows/durable-ai-plan.yml
git commit -m "test(plans): gate Plans Workspace V2"
```

- [ ] **Step 8: Final release-candidate verification**

Run once more after the final commit:

```bash
npm run test:web
npx tsc --noEmit -p apps/web/app/tsconfig.json
npm run build:app
node scripts/test-blueprint-browser.mjs
node scripts/test-plans-workspace-browser.mjs
node scripts/test-page-review-browser.mjs
```

Do not claim complete/exhaustive AI takeoff. The release claim is only that the Plans Workspace V2 frontend and its preserved safety contracts passed the defined tests.

---

## Self-Review Coverage Map

- Blueprint dominance/full-height shell: Task 7.
- Sheet thumbnails as primary navigation: Task 4 + Task 7 browser test.
- Secondary page selector: Task 3.
- Single + Continuous modes with bounded full-resolution canvases: Task 7.
- Zoom, Fit Width, Fit Page, Actual Size, pointer-centered wheel zoom, pan: Task 3.
- Focus mode: Task 7.
- AI findings moved out of the top of the PDF and into Inspector: Task 5 + Task 8.
- Grounded Fly To and unmapped honesty: Tasks 1 + 6 + Task 7 browser test.
- Takeoff, Notes, Plan tabs: Task 5.
- Existing upload/payment/entitlement/consent/revision behavior: Task 8.
- Owner Page Review moved without auto-start/replay: Tasks 5 + 8 + 9.
- Existing PDF error/cancellation behavior: Tasks 2 + 9.
- Legacy viewer removed only after parity: Task 9.
- Existing and new unit/build/browser gates: Task 9.

## Completion Rule

A green TypeScript compile or Vite build is not completion. Plans Workspace V2 is complete only after the integrated browser verifier proves sheet navigation, source-grounded finding selection, no fabricated marker for unmapped findings, Single/Continuous behavior with a bounded live render window, Notes/layers/focus interactions, and the P0 Page Review no-automatic-request/no-replay invariant while the existing AI/payment recovery regressions remain green.
