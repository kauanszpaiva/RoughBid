const issueMessages: Record<string, string> = {
  documented_material_quote_required: 'Add a documented supplier quote for this material, then link the exact product to this component.',
  documented_supplier_quote_required: 'Import a supplier quote with the product, price, date and project location.',
  missing_price: 'Add a documented price source. An absent price remains pending.',
  quantity_missing: 'Review the source drawing or photo and confirm the quantity of this component.',
  measurement_review_required: 'Confirm the physical measurement and its source before pricing this component.',
  catalog_specification_review_required: 'Review the material or service specification against its documented source.',
  scope_selection_pending: 'Choose whether this component belongs in the project scope.',
  input_missing: 'Enter the documented dimension or coefficient required by this component.',
  input_review_required: 'Check this input and cite its dimension or specification source.',
  input_unit_mismatch: 'Check the unit of this dimension or coefficient.',
  quantity_unit_mismatch: 'Choose a service whose unit matches the reviewed quantity.',
  coverage_unit_mismatch: 'Check the product coverage unit against the measured surface.',
  purchase_packaging_pending: 'Document package coverage, order increments, minimum order and rounding before calculating purchases.',
  waste_pending: 'Enter a reviewed waste allowance supported by the installation scope.',
  labor_productivity_pending: 'Document crew productivity, setup and cleanup time before calculating labor.',
  labor_productivity_and_rates_pending: 'Add documented crew productivity and labor rates for this service.',
  labor_productivity_source_review_required: 'Review the source of the crew productivity assumption.',
  crew_size_pending: 'Confirm the crew size and whether the rate is per person or per crew.',
  equipment_selection_and_allocation_pending: 'Choose applicable equipment and document its share of project usage.',
  equipment_access_scope_pending: 'Confirm whether site access equipment is required.',
  equipment_site_and_access_review_required: 'Check access dimensions, working height, load capacity and ground conditions.',
  scope_pending: 'Confirm whether this cost or equipment item is needed for this project.',
  composition_missing: 'Add the documented components of this service.',
  catalog_item_missing: 'Choose an available catalog material or service.',
  composition_cycle: 'Review the service composition: a component refers back to the same service.',
  price_and_document_review_required: 'Review the supplier document and its quoted unit price.',
  product_specification_review_required: 'Confirm the exact SKU, model, packaging and specification in the supplier quote.',
  supplier_validity_policy_required: 'Document how long the supplier quote remains valid.',
  source_date_stale_or_unverified: 'Refresh the supplier evidence or confirm its date for the selected store.',
  project_location_required: 'Choose the actual project ZIP, supplier store and time zone.',
  availability_for_quantity_unverified: 'Confirm that the supplier can provide the required quantity.',
  requested_quantity_unavailable: 'Check another documented supply option or update the requested quantity.',
  quote_scope_or_contract_eligibility_mismatch: 'Check that this quote matches the selected product, store, quantity and purchasing channel.',
  unknown_provider_outcome: 'A provider response could not be confirmed. Reconcile the saved attempt before restarting.',
  storage_unavailable: 'The private source could not be loaded. Restore source access and reload the saved job.',
  physical_dimension_reference_required: 'Add a separately verified dimension or instrument reading for this surface.',
  physical_scale_missing: 'Review the physical scale using supported source references.',
  human_measurement_review_required: 'Review this physical measurement against its source and record a checked count or dimension.',
  object_identity_review_required: 'Identify the same physical element across source views and check for duplicates.',
  independent_review_pending: 'An independent evidence review remains pending before the result can be released.',
  deterministic_photo_calibration_required: 'Mark four corners of a real rectangle, enter both known dimensions and trace the measured surface.',
  photo_planar_source_mismatch: 'Reload the verified photo revision and re-mark the reference on that exact source.',
  photo_planar_reference_review_required: 'Verify the physical rectangle and review lens distortion before using this reference.',
  photo_planar_dimensions_required: 'Enter both known physical dimensions of the reference rectangle.',
  photo_planar_geometry_review_required: 'Check that the traced boundary is on the reference plane and follows the actual surface.',
  degenerate_photo_planar_calibration: 'Choose four distinct corners of a clearly visible rectangular reference.',
  degenerate_photo_planar_geometry: 'Trace a distinct, usable boundary or line on the measured surface.',
  self_intersecting_photo_planar_geometry: 'Correct the boundary so its edges do not cross.',
  photo_planar_extrapolation_forbidden: 'Keep the measured boundary inside the verified reference rectangle, or provide another physical reference.',
  photo_planar_reference_resolution_insufficient: 'Use a clearer, higher-resolution view of the known rectangular reference.',
  source_revision_superseded: 'This source revision has changed. Review the latest saved extraction before accepting a measurement.',
};
/** Preserve raw codes in advanced diagnostics; primary UI explains the next action. */
export function reviewIssueMessage(value: string): string {
  const exact = value.trim().split(':').at(-1) ?? value;
  if (issueMessages[exact]) return issueMessages[exact];
  return /^[A-Za-z0-9_.:/-]+$/.test(value.trim()) && value.includes('_')
    ? 'Additional evidence needs review. Open the advanced diagnostics for its source details.' : value;
}
export function reviewIssueMessages(values: readonly string[]): string[] {
  return [...new Set(values.map(reviewIssueMessage))];
}
