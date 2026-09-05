# RoughBid New England AI and Price Marketplace

Status: planning baseline for implementation. Reviewed September 4, 2026.

## Product Boundary

RoughBid accelerates estimating and flags jurisdiction-sensitive assumptions. It must not claim automated code approval, engineering certification, or permit compliance.

Plan uploads can contain owner IP, addresses, security details, stamped drawings, and contract-confidential material. Keep tenant isolation, private storage, retention controls, audit logs, and export/delete paths as first-class requirements.

## New England Code Metadata

Store code metadata and official source links. Do not copy licensed model-code text into the product or training corpus without a license.

| State | Current code reference | Product handling |
| --- | --- | --- |
| MA | 780 CMR, 10th Edition, effective October 11, 2024 | Store MA amendments and permit-date applicability metadata. |
| RI | 510-RICR, statutes, ICC/NFPA incorporated codes, major updates effective December 1, 2025 | Statewide metadata, amendments, and permit-date handling. |
| CT | 2022 Connecticut State Building Code, permits from October 1, 2022 | Permit-file date is required. |
| NH | State Building Code with 2024 ICC family references and 2018 IECC retained | Require jurisdiction and permit date because local enforcement can matter. |
| VT | 2025 Vermont Fire & Building Safety Code | Treat public building, occupancy, fire/life-safety, and accessibility flags as review-required. |
| ME | MUBEC, effective April 7, 2025, with municipal enforcement thresholds | Model municipality enforcement and stretch-code flags. |

Authoritative source classes:
- State building-code agencies and administrative-code portals.
- State fire marshal / public safety departments where they own code adoption.
- Municipal code pages only as local overlays.
- ICC/model-code text only through a licensed provider or user-provided licensed content.

## Price Data Strategy

Use layered pricing instead of one opaque model output:

1. `canonical_takeoff_item`: normalized plan-derived objects such as wall LF, slab SF, fixture EA, door schedule rows, roof SF, excavation CY.
2. `assembly_recipe`: maps item, trade, construction method, quality level, waste, labor units, and CSI/MasterFormat reference.
3. `market_price_book`: source-specific price rows by state, county, metro, effective date, license scope, unit, min/max, confidence, source URL, and user override.

Source classes:
- Workspace private price book: supplier costs, internal labor rates, assemblies, historical actuals.
- Public benchmarks: state DOT bid tabs, weighted average prices, and BLS OEWS wage context.
- Licensed add-ons: RSMeans/Gordian or another approved cost-data provider.
- Project feedback loop: won/lost estimates, actual costs, change orders, and estimator corrections.

Public civil/DOT prices are benchmarks, not residential/commercial defaults. Prevailing wage and Davis-Bacon must be explicit project settings, not silent defaults.

## ML Pipeline

Phase 1: deterministic takeoff foundation
- PDF ingestion, sheet classification, title block/revision extraction, scale calibration.
- Visible measurements for areas, lengths, counts, schedules, and symbols.
- Every quantity stores sheet, coordinates, confidence, extraction method, and reviewer.

Phase 2: supervised extraction
- Label by trade and sheet type: architectural, structural, MEP, civil/site, roof, finish schedules.
- Train separate extractors for rooms/walls, doors/windows, fixtures, roof planes, site quantities, and notes/specs.
- Use active learning from estimator corrections.

Phase 3: assembly mapping
- Map quantities to assemblies using project type, region, code metadata, quality level, and estimator defaults.
- Require estimator approval for assumptions before proposal export.

Phase 4: regional pricing
- Start with private price books plus public benchmarks.
- Add licensed cost-data integrations only after contract approval.
- Track source age, region mismatch, range, and confidence in every estimate line.

Phase 5: compliance-aware assistant
- Address to jurisdiction resolver.
- Permit-date applicability.
- Review-required flags for structural, fire/life-safety, energy, accessibility, public funding, stamped drawing conflicts, and unusual assemblies.

## Marketplace Add-ons

Initial paid modules:
- New England Public Benchmarks.
- Licensed Cost Data Feed.
- Contractor Private Price Book Sync.
- Public Work Wage/Bonding Module.
- Client View and E-Sign Tracking.

Each add-on needs entitlement checks, Stripe metadata, source-license metadata, and audit logs.
