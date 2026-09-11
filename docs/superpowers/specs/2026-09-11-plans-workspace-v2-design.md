# RoughBid Plans Workspace V2 Design

**Status:** Approved design, pending implementation-plan approval  
**Date:** 2026-09-11  
**Repository:** `kauanszpaiva/RoughBid`  
**Primary area:** `apps/web/app/src`  

## 1. Purpose

Rebuild the RoughBid Plans experience so the construction drawing is the primary working surface rather than a preview embedded inside a conventional dashboard page.

The V2 Plans Workspace must feel like a professional blueprint-review and estimating tool: the PDF occupies most of the available viewport, sheet navigation is persistent and visual, AI findings and takeoff information live in a contextual inspector, and the user can move quickly between whole-plan review and detailed inspection without losing context.

The redesign must preserve all existing production-sensitive behavior around plan upload, workspace entitlements, billing, AI consent, plan-reading jobs, saved results, page-by-page owner review, and revision handling. This is a frontend architecture and interaction redesign, not a rewrite of billing or AI semantics.

## 2. Product Principles

1. **The blueprint is the product surface.** The drawing receives the largest share of the screen at all supported desktop sizes.
2. **Context surrounds the plan; it does not displace it.** Findings, takeoff, notes, and plan metadata belong in side panels or overlays, not above the canvas.
3. **Navigation must be spatial and visual.** A sheet navigator with thumbnails replaces the page dropdown as the primary navigation mechanism.
4. **AI must be visibly grounded in source evidence.** Clicking an AI finding navigates to the source sheet and available source geometry. No client-side coordinate invention is allowed.
5. **Explicit actions remain explicit.** Merely opening the workspace or page-review UI must never start an AI request, payment action, upload, or other metered side effect.
6. **Preserve backend truth.** The frontend may present, filter, and navigate saved findings, but it must not manufacture quantities, geometry, payment state, page-review completion, or processing success.
7. **Desktop-first without becoming desktop-only.** The primary experience targets professional laptop and desktop estimating. Smaller screens use drawers and overlays while preserving access to core workflows.
8. **Improve structure without unrelated rewrites.** Existing upload, billing, entitlement, AI consent, and revision workflows stay functionally stable while the Plans UI is decomposed around them.

## 3. Scope

### 3.1 In Scope

- Full-height Plans workspace layout.
- Left-side sheet navigator with PDF thumbnails.
- Central PDF canvas using the existing PDF.js dependency.
- Single-page and continuous-scroll viewing modes.
- Improved zoom, fit, pan, keyboard, and mouse navigation.
- Focus mode for near-fullscreen blueprint inspection.
- Right-side inspector with AI Findings, Takeoff, Notes, and Plan tabs.
- Integration of the existing owner page-by-page review into the AI inspector.
- Finding-to-source navigation using valid page number and geometry.
- Manual annotation presentation and navigation.
- Layer visibility controls for AI markers, bounding boxes/highlights, and manual notes.
- Responsive desktop/laptop/tablet panel behavior.
- Performance controls for large multi-page PDFs.
- Unit and browser-level regression coverage for critical viewport and side-effect behavior.
- Incremental component decomposition of the existing `BlueprintViewer.tsx` and `PlansPageContent.tsx` responsibilities.

### 3.2 Out of Scope

- Rewriting AI extraction providers or prompts.
- Enabling closed Full Takeoff V2 feature flags.
- Changing pricing, Stripe payment semantics, or membership discounts.
- Changing workspace entitlement rules.
- Changing AI consent rules.
- Changing project-file storage or signed preview/download semantics.
- Automatically accepting AI quantities into estimates.
- Claiming exhaustive takeoff completeness because all pages were processed.
- Adding a CAD editor or vector drawing editor.
- Adding arbitrary PDF editing, page deletion, page rotation persistence, or document mutation.
- Replacing PDF.js with a paid or proprietary PDF SDK.
- Adding a new global state-management library.
- Building a mobile-phone-first estimating workflow.

## 4. Current-State Constraints to Preserve

The current frontend already has important safety and product behavior that V2 must preserve:

- `PlansPageContent.tsx` owns upload orchestration, private preview URL loading, entitlement checks, billing quote recovery, AI consent, paid/included plan-reading actions, revision metadata, and current-revision selection.
- `BlueprintViewer.tsx` already renders PDFs using `pdfjs-dist`, cancels stale page renders, displays valid AI geometry, supports manual note markers, and avoids drawing an AI marker when no valid source point or bounding box exists.
- The owner-only page-by-page review loads inventory separately from starting page analysis. Loading inventory must remain read-only.
- Page-by-page processing is explicit, resumable, and preserves already-saved physical-page results.
- An uncertain or failed page request must not be silently replayed. The client reconciles server state before the user attempts another action.
- Existing feature flags, company/daily limits, and backend authorization remain authoritative.

The redesign may relocate these capabilities but may not weaken these invariants.

## 5. Information Architecture

The desktop Plans Workspace consists of four persistent regions:

```text
+----------------------------------------------------------------------------------+
| Existing RoughBid project/header navigation                                      |
+-------------+------------------------------------------------+-------------------+
| SHEETS      | BLUEPRINT WORKSPACE                            | INSPECTOR         |
|             |                                                |                   |
| thumbnails  | floating/compact viewer toolbar                | AI                |
| sheet names |                                                | Takeoff           |
| page state  |                PDF / BLUEPRINT                 | Notes             |
|             |                                                | Plan              |
|             |                                                |                   |
+-------------+------------------------------------------------+-------------------+
| Workspace status: sheet / revision / findings / save-processing state            |
+----------------------------------------------------------------------------------+
```

### 5.1 Default Desktop Widths

At a typical 1440 px or wider application content width:

- Sheet navigator target width: 200-230 px.
- Inspector target width: 320-380 px.
- Blueprint region: all remaining width.

At narrower laptop widths:

- Sheet navigator may shrink to approximately 160 px.
- Inspector may shrink to approximately 300 px.
- The blueprint remains the highest-priority region.

Panels must be independently collapsible.

## 6. Workspace Shell

### 6.1 `PlansWorkspace`

`PlansWorkspace` is the new view-level composition component for the blueprint experience. It coordinates layout and view state but does not own billing, upload, entitlement, or provider-side AI behavior.

It receives the current revision, preview state, findings, annotations, and callbacks from the existing page controller. It owns UI-only state including:

```ts
type PlansViewMode = 'single' | 'continuous';
type PlansFitMode = 'manual' | 'width' | 'page';
type PlansInspectorTab = 'ai' | 'takeoff' | 'notes' | 'plan';

type PlansWorkspaceState = {
  activePage: number;
  viewMode: PlansViewMode;
  zoomPercent: number;
  fitMode: PlansFitMode;
  leftPanelOpen: boolean;
  inspectorOpen: boolean;
  focusMode: boolean;
  inspectorTab: PlansInspectorTab;
  selectedFindingId: string | null;
  selectedAnnotationId: string | null;
  showAiMarkers: boolean;
  showFindingHighlights: boolean;
  showManualNotes: boolean;
};
```

The exact implementation may use colocated React state and focused hooks rather than a single reducer, but these semantics must remain clear and isolated from metered/product-side actions.

### 6.2 Removal of Page-Style Width Constraint

The Plans workspace must not use the current `max-w-6xl mx-auto` layout constraint. The workspace consumes the available application content width and the available height below the existing RoughBid project/header navigation.

The goal is to eliminate unnecessary outer whitespace and card stacking around the plan.

## 7. Sheet Navigator

### 7.1 Purpose

The Sheet Navigator is the primary page-navigation interface. The existing numeric page selector remains available in the toolbar as a compact secondary control.

### 7.2 Content

Each sheet entry contains:

- Low-resolution PDF thumbnail.
- Physical page number.
- Sheet number/title when reliable metadata exists.
- Active-page state.
- Optional saved page-review status when available to the authorized owner.

If a sheet title is unavailable, the display name is `Page 01`, `Page 02`, and so on. The UI must not fabricate architectural sheet numbers such as `A1.0` unless they come from known document/AI metadata.

### 7.3 Behavior

- Clicking a thumbnail navigates to that physical PDF page.
- Up/down keyboard navigation moves through the sheet list when the navigator has focus.
- A compact sheet search filters known sheet labels/titles; physical page navigation remains accessible even when a search filter is active.
- Active page stays synchronized with the viewer.
- In continuous mode, the active page updates according to the page most meaningfully present in the viewport.
- The navigator can collapse to a narrow rail and expand again.

### 7.4 Thumbnail Rendering

Thumbnails are rendered independently from the main page canvas at low resolution. They must not reuse a full-resolution canvas bitmap or force all document pages into full-resolution memory.

Thumbnail jobs should be lazy and cancelable. Visible and near-visible thumbnail entries receive priority.

## 8. PDF Viewer Architecture

The existing `pdfjs-dist` dependency remains the PDF engine.

### 8.1 Document Loading

PDF loading remains tied to the private `previewUrl` generated by the existing page controller. The viewer receives the URL and exposes document state to child components.

Required document states:

```ts
type PdfDocumentStatus = 'idle' | 'loading' | 'ready' | 'failed';
```

Changing revision or preview URL cancels/destroys stale loading work and resets page-local selection state.

### 8.2 Single-Page Mode

Single-page mode is the default precision-review mode.

It renders one active physical page into the main blueprint area. Previous/next controls, the sheet navigator, keyboard commands, and finding navigation may change the active page.

### 8.3 Continuous Mode

Continuous mode renders a vertical document stream with correct page aspect-ratio placeholders and lazy page canvases.

It must not eagerly render every page of a large document at full resolution.

Required behavior:

- `IntersectionObserver` or equivalent viewport observation identifies pages near the visible viewport.
- Visible pages and a small nearby buffer are render candidates.
- Distant pages retain measured placeholders without live full-resolution canvases.
- Render tasks are canceled when a page leaves the relevant rendering window or when zoom/document state invalidates the task.
- Scrolling updates `activePage` without triggering AI or backend writes.
- Switching back to single-page mode preserves the current active physical page.

No new virtualization dependency is required for V2.

## 9. Zoom, Fit, and Pan

### 9.1 Zoom Range

Manual zoom supports approximately 25% through 500%. The UI may clamp to these exact values.

Toolbar controls include:

- Zoom out.
- Zoom percentage display/input.
- Zoom in.
- Fit Width.
- Fit Page.
- 100% / Actual Size.

### 9.2 Wheel Zoom

Ctrl/Cmd + wheel changes zoom progressively.

Where practical, the point beneath the pointer remains approximately anchored by adjusting scroll position after the scale change. The implementation must avoid large visual jumps that lose the inspected detail.

Normal wheel scrolling without Ctrl/Cmd continues to scroll the workspace.

### 9.3 Pan

The viewer supports:

- Explicit Hand tool drag.
- Spacebar + primary-button drag as temporary pan.
- Middle-button drag where browser behavior permits.

Panning must not accidentally create a manual note.

### 9.4 Fit Behavior

`Fit Width` and `Fit Page` are responsive modes rather than one-time zoom buttons.

When a side panel opens/closes or the viewport resizes while a fit mode is active, the effective zoom recalculates to preserve that fit mode.

A manual zoom action changes fit mode to `manual`.

## 10. Toolbar

The blueprint toolbar is compact and visually secondary to the drawing.

Desktop grouping:

```text
[Prev] [Page 3 / 10] [Next] | [Hand] | [-] [100%] [+] [Fit] | [Layers] [Note] [View: Single] [Focus]
```

The exact icon order can adapt for width, but the following capabilities must remain directly available or one menu level away:

- Physical page navigation.
- Pan/hand mode.
- Zoom controls.
- Fit Width / Fit Page / 100%.
- Layers visibility.
- Manual note mode when `canWrite` is true.
- Single / Continuous mode selection.
- Focus mode.

Disabled actions must expose normal disabled semantics and accessible labels rather than relying only on visual opacity.

## 11. Focus Mode

Focus Mode maximizes the plan for concentrated review.

Entering Focus Mode hides or collapses:

- Main RoughBid sidebar where the surrounding app architecture permits it without breaking navigation state.
- Sheet Navigator.
- Inspector.
- Nonessential Plans chrome.

The blueprint toolbar remains available.

`Escape` exits Focus Mode.

Focus Mode is UI-only. It must not mutate project data, selected revision, findings, or backend state.

## 12. Inspector

The right Inspector has four top-level tabs:

```ts
type PlansInspectorTab = 'ai' | 'takeoff' | 'notes' | 'plan';
```

The Inspector is independently collapsible. On narrow layouts it becomes an overlay/drawer rather than permanently reducing the blueprint below a usable width.

## 13. AI Inspector

The AI tab contains two views for authorized contexts:

- Findings.
- Page Review.

For users who do not have access to owner page review, only applicable general findings controls are shown.

### 13.1 Findings List

The findings view contains:

- Search.
- Finding-type/trade filters based on available data.
- Finding count.
- Compact finding rows.
- Confidence.
- Physical source sheet/page.
- Quantity/value when present.
- Mapped/unmapped indication.

The existing finding status behavior remains authoritative; rejected findings remain excluded from normal review presentation unless another existing product flow intentionally exposes them.

### 13.2 Finding Selection

Selecting a finding sets `selectedFindingId` and invokes source navigation.

If the finding has a valid physical page number:

1. Make that page active.
2. Ensure the page is rendered or scheduled for rendering.
3. Use valid geometry when available.
4. Center/focus the source region.
5. Visually emphasize the selected source geometry.
6. Present source evidence and metadata in the Inspector.

If geometry is absent or invalid, the UI still navigates to the known physical page but labels the result as unmapped. It must not guess a source point.

If a finding references an impossible page number for the currently loaded PDF, the UI treats it as source data needing attention and does not attempt an invalid viewer navigation.

### 13.3 `Fly To` Geometry

Supported source geometry remains:

- normalized bounding box `[x, y, width, height]` with each value finite and within valid page bounds;
- normalized point `[x, y]` within `[0, 1]`.

Bounding box has precedence over point when both are valid.

For a bounding box, `Fly To` should choose a zoom that makes the box comfortably visible while respecting the 25%-500% zoom limits and available blueprint viewport.

For a point, `Fly To` centers the point and retains a useful current/derived zoom rather than zooming to an arbitrary extreme.

### 13.4 Visual Emphasis

Default AI overlay presentation should be less visually noisy than the existing always-visible box-heavy state.

Recommended default:

- AI markers visible.
- Full finding highlights/bounding boxes subdued or shown for selected/hovered findings.
- Selected finding receives a strong highlight/ring and optional compact label.
- Risk findings may retain distinct risk styling.

The selected source must remain recognizable without making the full plan unreadable.

## 14. Owner Page Review Integration

The existing owner page-by-page review semantics are P0 invariants.

### 14.1 Read-Only Inventory

Opening the AI tab or Page Review subview must not call an AI model.

The user performs an explicit `Load PDF page inventory` / equivalent read-only action if the product continues to require manual inventory loading. A future implementation may safely prefetch inventory only if the underlying operation remains a GET/read-only server call with no model invocation, no reservation, and no metered provider action.

### 14.2 Explicit Page Analysis

Starting physical-page analysis requires an explicit user action such as:

- Analyze selected page.
- Analyze remaining pages.

The UI must preserve the existing protections:

- skip pages that already have a saved job ID;
- preserve already-saved results;
- pause only between requests when the user asks to pause;
- do not cancel or pretend to cancel a provider request already sent;
- do not automatically retry an uncertain request;
- reconcile server inventory after an uncertain response before another attempt;
- never present all processed pages as proof of exhaustive takeoff correctness.

### 14.3 Page Status in Sheet Navigator

For an authorized owner with loaded inventory, the Sheet Navigator may display compact page-review status indicators. These indicators are derived from saved inventory only and must not initiate requests.

## 15. Takeoff Inspector

The existing area-grouped takeoff/report information moves out of the PDF viewer and into the Takeoff tab.

The Takeoff tab may present grouped findings by area and quantities already produced by the existing backend/result model.

It must preserve current honesty rules:

- Missing cost configuration is presented as missing, not substituted.
- Missing quantity is shown as review-required or equivalent.
- Room floor area is not silently converted into wall/drywall area.
- Grouping or aggregation must not create new measurements that were not present in source findings.

Selecting an item that maps to a source finding uses the same `Fly To` navigation behavior.

## 16. Notes Inspector

The Notes tab presents manual plan annotations across all physical pages.

Each note row contains at least:

- Physical page number.
- Note text.
- Selected state.

Selecting a note navigates to its page and normalized coordinate.

Manual note creation retains existing rules:

- available only when `canWrite` is true;
- requires an explicit note tool/mode;
- clicking the plan while another navigation/pan action is active must not create a note;
- note text remains length-limited to the existing safe bound of 500 characters unless a separate product change modifies that rule.

The redesign does not add note editing/deletion unless already supported elsewhere; V2's required behavior is create, view, select, and navigate.

## 17. Plan Inspector

The Plan tab consolidates administrative metadata and revision actions that currently occupy permanent right-side cards.

It contains applicable existing functions:

- File name.
- Current revision number.
- Upload date.
- Uploaded by.
- Physical page count.
- File size.
- Processing status.
- Upload new revision.
- View revision history.
- Rename file.
- Download original.
- Delete/remove plan set where currently permitted.

Dangerous/destructive actions remain visually separated from routine metadata.

Existing permission checks remain authoritative.

## 18. Layers

Layers are a compact toolbar popover rather than a permanent panel.

Required toggles:

- AI markers.
- AI finding highlights/bounding boxes.
- Manual notes.

The implementation may add nested trade/type visibility only when based on existing finding metadata. It must not imply that hidden/unavailable disciplines were analyzed.

Layer visibility is presentation state only and must not mutate saved AI findings or annotations.

## 19. Status Bar

A compact workspace status region may show:

- Active sheet/page.
- Revision.
- Count of visible/reviewable findings.
- PDF render/load state.
- Save/sync status when already available from the surrounding product.

The status bar must not claim `complete takeoff`, `verified`, or similar semantics solely because rendering or AI page processing finished.

## 20. Loading and Error States

### 20.1 Document Loading

While a PDF is opening, keep the workspace shell visible and show a local blueprint loading state such as:

`Opening blueprint...`

The user should still understand which file/revision is selected.

### 20.2 Page Rendering

Individual pages display a local skeleton/placeholder while rendering.

A failed page render does not have to destroy the entire document session. The affected page may offer:

- Retry render.
- Download original.

### 20.3 Preview Failure

If the signed preview cannot be loaded, the Inspector and known project metadata may remain available. The viewer presents the existing error rather than clearing saved findings or rewriting revision state.

### 20.4 Empty Plan State

When no current revision exists, the central region provides a clear upload entry point when the user has write permission. The empty state does not show inert PDF controls as though a document were loaded.

## 21. Responsive Behavior

### 21.1 Wide Desktop

- Both Sheet Navigator and Inspector open by default.
- Blueprint uses remaining width.

### 21.2 Laptop

- Panels use narrower defaults.
- Either panel can collapse.
- Core toolbar remains usable without horizontal page-level overflow.

### 21.3 Tablet / Narrow Application Width

- Sheet Navigator becomes a drawer/overlay.
- Inspector becomes a drawer/overlay.
- Blueprint remains the central surface.
- Opening a drawer must not permanently shrink the PDF below a usable review area.

### 21.4 Phone

The application may offer a constrained read/review experience, but V2 does not promise full professional estimating ergonomics on small phone screens.

## 22. Accessibility and Input

Required accessibility behavior:

- Viewer toolbar buttons have explicit accessible names.
- Active/pressed tools expose `aria-pressed` where appropriate.
- Tabs use accessible tab semantics or an equivalent keyboard-navigable pattern.
- Disabled actions use native disabled behavior when possible.
- Sheet thumbnails expose physical page identity in text, not image alone.
- Findings and notes are keyboard selectable.
- Focus indicators remain visible.
- Color is not the only indicator of finding/risk/status state.
- `Escape` exits focus mode and dismisses transient viewer popovers/drawers in a predictable order.

Keyboard behavior must avoid intercepting shortcuts when the user is typing in an input, textarea, select, or editable control.

## 23. Performance Requirements

The redesign must improve perceived and actual viewer performance rather than simply adding interface around the existing renderer.

Required performance rules:

1. Never intentionally render all pages of a large PDF at full resolution on initial load.
2. Use cancelable PDF.js render tasks.
3. Limit device-pixel-ratio amplification to a practical cap comparable to the existing viewer's cap of 2 unless measurement proves a safe alternative.
4. Thumbnails render at substantially lower resolution than main pages.
5. Continuous mode uses viewport-driven page rendering with placeholders for distant pages.
6. A revision/document change destroys obsolete PDF work and releases stale object/render resources.
7. Repeated layout changes from panel toggles must not create an uncontrolled render storm.
8. Fit-mode recalculation should be debounced or naturally bounded by ResizeObserver behavior.

No fixed promise such as a universal maximum load time is specified because plan complexity and network conditions vary, but the architecture must prevent memory growth proportional to `all pages × full-resolution canvas`.

## 24. Component Boundaries

Create a feature-oriented structure under:

`apps/web/app/src/features/plans/`

Target organization:

```text
features/plans/
  PlansWorkspace.tsx
  types.ts
  viewer/
    BlueprintCanvas.tsx
    BlueprintPage.tsx
    BlueprintToolbar.tsx
    FindingOverlay.tsx
    AnnotationOverlay.tsx
  sheets/
    SheetNavigator.tsx
    SheetThumbnail.tsx
  inspector/
    PlanInspector.tsx
    FindingsPanel.tsx
    TakeoffPanel.tsx
    NotesPanel.tsx
    PageReviewPanel.tsx
    PlanInfoPanel.tsx
  hooks/
    usePdfDocument.ts
    useBlueprintViewport.ts
    useContinuousPages.ts
    useFindingNavigation.ts
  utils/
    viewport.ts
    findingGeometry.ts
```

The implementation plan may adjust filenames when existing project conventions make a nearby alternative materially clearer, but responsibility boundaries must remain equivalent.

### 24.1 `PlansPageContent.tsx`

Initially remains the product/controller boundary for:

- upload;
- preview URL creation;
- entitlements;
- reading quote/payment recovery;
- AI consent;
- paid/included analysis start;
- current revision actions;
- persisted project update callbacks.

Its rendered layout changes to compose `PlansWorkspace`, but this project does not require simultaneously rewriting all product-side state into a new state architecture.

### 24.2 `BlueprintViewer.tsx`

The current monolithic viewer becomes transitional. Its PDF/render/navigation/overlay responsibilities move into focused feature components and hooks.

After V2 is integrated, the old component should either be removed or reduced to a thin compatibility wrapper if another route still consumes it. No duplicated production viewer implementations should remain indefinitely.

### 24.3 Existing `PageReviewPanel.tsx`

The existing page-review logic is migrated into or wrapped by the feature-local Inspector component without changing request semantics. The migration must be proven by tests covering read-only inventory load and explicit analysis initiation.

## 25. Data Flow

The intended high-level data flow is:

```text
PlansPageContent
  |
  | currentRevision, previewUrl, findings, canWrite, callbacks
  v
PlansWorkspace
  +--> usePdfDocument --> PDF.js document
  +--> SheetNavigator --> activePage
  +--> BlueprintCanvas --> page renders + overlays
  +--> PlanInspector --> findings/takeoff/notes/plan controls

User selects finding
  -> useFindingNavigation
  -> activePage
  -> ensure target render
  -> compute valid source target
  -> viewer scroll/zoom
  -> selected overlay + evidence

User starts metered/product action
  -> existing controller/API function
  -> backend remains authoritative
```

UI-only viewer state must not be persisted as project business data unless a separate existing persistence contract already requires it.

## 26. Geometry and Viewport Utilities

Geometry validation and viewport targeting should be extracted into pure functions so they can be tested independently of React and PDF.js.

Required conceptual interfaces:

```ts
export type NormalizedBox = readonly [number, number, number, number];
export type NormalizedPoint = Readonly<{ x: number; y: number }>;

export function getValidFindingBox(finding: PlanReadingFinding): NormalizedBox | null;
export function getValidFindingPoint(finding: PlanReadingFinding): NormalizedPoint | null;

export function clampZoom(percent: number): number;

export function computeFitWidthZoom(args: {
  pageWidth: number;
  viewportWidth: number;
  horizontalPadding: number;
}): number;

export function computeFitPageZoom(args: {
  pageWidth: number;
  pageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  padding: number;
}): number;
```

Exact implementation names may be preserved from existing utilities if equivalent functions already exist, but the implementation plan must keep the logic pure/testable.

## 27. Visual Language

The visual design remains consistent with the current RoughBid application rather than introducing a new brand system.

Guidelines:

- White/slate application chrome.
- RoughBid blue for primary controls and manual annotations.
- Emerald/green family for standard AI finding accents where currently used.
- Amber/risk styling for risk findings.
- Avoid large decorative gradients or marketing-style cards inside the estimator workspace.
- Use compact spacing and small controls appropriate for a professional work surface.
- Use shadows primarily to establish floating toolbar/panel depth, not to turn every region into a card.
- Blueprint background may use a neutral light/darkened canvas field that visibly separates white PDF sheets from app chrome.

## 28. Testing Strategy

### 28.1 Unit Tests

Use the existing Node test setup under `apps/web/test/*.test.ts` for pure logic.

Unit coverage must include at minimum:

- bounding-box validation;
- point validation;
- zoom clamping;
- fit-width calculation;
- fit-page calculation;
- finding navigation fallback when geometry is absent;
- impossible/invalid source page handling;
- continuous-mode active-page selection logic if extracted as a pure helper.

### 28.2 Browser Verification

Add or extend browser-level verification to prove the integrated workflow:

1. Open a project with a saved PDF.
2. Enter Plans.
3. Verify PDF renders.
4. Navigate from sheet thumbnails.
5. Navigate via toolbar page controls.
6. Zoom in/out.
7. Fit Width.
8. Fit Page.
9. Enter/exit Continuous mode.
10. Confirm active sheet synchronization while scrolling.
11. Select a mapped AI finding and verify navigation/highlight/evidence.
12. Select an unmapped finding and verify no invented marker appears.
13. Toggle AI/manual-note layers.
14. Enter/exit Focus Mode.
15. Open Inspector tabs without triggering unintended API side effects.

### 28.3 P0 Page-Review Regression

Browser/network verification must explicitly prove:

- Opening Plans does not start physical-page AI analysis.
- Opening the Page Review subview does not start physical-page AI analysis.
- Loading page inventory does not start physical-page AI analysis.
- Clicking Analyze Selected Page results in exactly one explicit page-analysis request.
- Clicking Analyze Remaining Pages does not re-request pages already represented by saved job IDs.
- An uncertain response is reconciled before another attempt; no automatic POST replay occurs.

### 28.4 Existing Gates

Before implementation is declared ready:

- `npm run test:web` passes.
- `npm run build:app` passes.
- Applicable existing browser verification scripts pass.
- New Plans Workspace browser checks pass.
- No Full Takeoff V2 flags are enabled as part of this change.

## 29. Migration Strategy

Implement V2 incrementally so product-side behavior remains available throughout the work.

Recommended sequence:

1. Extract/test pure geometry and viewport utilities.
2. Extract PDF document/render primitives without changing business actions.
3. Build single-page workspace composition.
4. Add Sheet Navigator and thumbnails.
5. Move findings/notes/takeoff/plan metadata into Inspector panels.
6. Integrate `Fly To` behavior.
7. Add Continuous mode with lazy rendering.
8. Integrate owner Page Review in the AI Inspector while preserving side-effect semantics.
9. Add focus/responsive states.
10. Remove or reduce obsolete viewer layout only after regression checks prove parity.

A production merge should contain a coherent working V2 rather than exposing a half-migrated UI to end users unless the repository already has a suitable closed feature flag for the intermediate state.

## 30. Acceptance Criteria

The redesign is accepted when all of the following are true:

- Plans uses available workspace width instead of a centered `max-w-6xl` content column.
- The PDF is visually the dominant content region.
- Sheet thumbnails provide primary navigation.
- The top-of-viewer findings list no longer consumes vertical PDF space.
- AI findings reside in the Inspector and can navigate to valid source geometry.
- Unmapped findings never receive fabricated client-side coordinates.
- Both Single Page and Continuous viewing modes work.
- Continuous mode does not eagerly render every page at full resolution.
- Zoom, Fit Width, Fit Page, and pan workflows are usable with mouse and keyboard.
- Panels are independently collapsible and Focus Mode provides a near-fullscreen drawing experience.
- Takeoff/report content lives outside the PDF viewport.
- Manual notes remain grounded to physical page coordinates.
- Plan metadata/revision actions remain available without permanently consuming a full dashboard card column.
- Existing upload, entitlement, billing, consent, paid/included AI, preview, and revision behavior remains functionally intact.
- Owner page-review inventory remains read-only.
- Physical-page analysis remains explicit and non-replaying.
- Existing and new web tests/build/browser gates pass.

## 31. Non-Negotiable Safety and Truthfulness Rules

1. Never visually imply that AI found geometry when no valid geometry exists.
2. Never treat a rendered PDF page as proof that AI analyzed it.
3. Never treat an AI-processed physical page as proof of exhaustive takeoff completeness.
4. Never automatically start or retry a metered AI request because the user opened, reloaded, navigated, or changed view mode.
5. Never replace backend payment/entitlement truth with client guesses.
6. Never silently accept generated quantities into the estimate as part of this frontend redesign.
7. Never mutate the original PDF during viewer interactions.

## 32. Definition of Done

Plans Workspace V2 is done only when the UI architecture, viewer behavior, side-effect protections, performance strategy, responsive behavior, and regression coverage in this specification are implemented and verified together.

A green build alone is not sufficient. The final verification must demonstrate the actual Plans flow in a browser, including source-grounded finding navigation and the P0 page-review no-automatic-request invariant.
