# Reviewed planar photo measurements

This branch adds a deterministic photo-to-plane calculation. The human reviewer
selects four image points on a real rectangle, supplies its known width and
height, and explicitly reviews coplanarity, rectangle correspondence and lens
distortion. RoughBid solves the eight homography coefficients mapping normalized
image coordinates to a unit rectangle, then scales the two plane axes to metres.
It maps a separately reviewed polygon or polyline and calculates shoelace area,
closed-boundary perimeter or open-path Euclidean length. No model output supplies
the approved quantity. [OpenCV's homography tutorial](https://docs.opencv.org/4.x/d9/dab/tutorial_homography.html)
describes the planar transformation and the camera/distortion assumptions.

## API contract

The existing authenticated `POST /api/projects/:projectId/photos/runs/:runId/review`
still requires `expectedReviewRevision` and a UUID `reviewRequestKey`. The outer
reference retains `kind: "planar_calibration"`, `value` equal to the known width,
`unit` equal to its length unit, and reviewed `verified`, `coplanarVerified`,
`perspectiveVerified`. Reviewer IDs are set from authenticated identity.

The reference additionally contains:

```json
{
  "planarCalibration": {
    "version": "photo-planar-v1",
    "sourceAssetId": "stored-photo-id",
    "sourceRevision": "saved-revision",
    "sourceSha256": "saved-sha256",
    "surfaceKey": "reviewed-plane",
    "referencePoints": [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]],
    "referenceWidth": 10,
    "referenceHeight": 12,
    "referenceUnit": "LF",
    "rectangleVerified": true,
    "lensDistortionReviewed": true
  }
}
```

Points are cyclic corresponding corners: origin, width endpoint, opposite corner,
height endpoint. The UI describes these as top-left, top-right, bottom-right,
bottom-left. Inputs are normalized against the stored source image. Cropping,
rotating, resizing or undistorting a new source requires a new verified asset;
screen coordinates must be converted using the displayed source frame. The
server never sorts or silently reorders corners.

The decision has `method: "calibrated_planar_geometry"`, `quantity: null`, a
supported output unit, its reference ID, physical object identity, reviewed view
identity and resolved human review. It additionally contains:

```json
{
  "planarMeasurement": {
    "version": "photo-planar-v1",
    "sourceAssetId": "stored-photo-id",
    "sourceRevision": "saved-revision",
    "sourceSha256": "saved-sha256",
    "surfaceKey": "reviewed-plane",
    "kind": "polygon",
    "points": [[0.1, 0.1], [0.5, 0.1], [0.5, 0.9], [0.1, 0.9]],
    "measure": "area",
    "samePlaneReviewed": true,
    "geometryReviewed": true
  }
}
```

Reference length units are `M` or `LF`; a foot equals exactly 0.3048 metres.
Area outputs support `SF`, `SY`, `SQ`; perimeter/open-path length supports `LF`.
Polygon points number 3–64 with no duplicated closing point; polyline points
number 2–64. For the example above the result is 60 SF, while the full rectangle
is 120 SF. A client-supplied planar quantity is blocked rather than trusted.

## Evidence, persistence and limits

Approved measurements include `measurementScope: "reviewed_planar_region"` and
`planarProofs`. The result also lists those proofs. Each proof binds the exact
asset/hash/revision/plane, known dimensions, reviewed source points, selected
geometry, row-major image-to-plane matrix in metres, transformed points, SI
area/perimeter/length, conversion/rounding and SHA-256 fingerprints. The method is
recorded as `homography_rectangle_v1_area`, `_perimeter` or `_length`.
Hashes establish calculation identity; they are not external signatures or
certification of the physical input. Successful human review still saves through
the existing atomic revision/CAS and immutable idempotency receipt.

This version accepts a simple planar region inside the calibrated convex
quadrilateral. It blocks extrapolation, self-intersections, repeated/degenerate
corners, unbounded/nonfinite input, unknown units, stale asset metadata and
unreviewed plane membership. Each control edge must span at least two stored
pixels and the control region at least 16 square pixels. It checks pivot bounds,
reference reprojection and nonzero consistent-sign projective denominators;
the denominator ratio is bounded at 10,000. Those are numerical safeguards, not
accuracy thresholds for a construction survey.

There is no hole subtraction, curved surface, lens correction, camera pose,
depth or 3D volume inference in this contract. A selected polygon measures only
that visible, reviewed planar scope; hidden work and openings are never deducted
or added automatically. Significant lens distortion needs a corrected source or
another calibrated capture. Four supplied correspondences fit exactly and do not
provide an independent accuracy check. Uncertainty remains explicitly
`not_statistically_quantified`, including point selection, supplied dimensions,
residual lens distortion and human coplanarity declarations. Independent review
is still pending; missing sourced compositions/prices keep the estimate null.

## Local verification

Pure fixtures cover imperial and metric rectangles, partial/concave polygons,
perimeter/open paths, a projective trapezoid with a known 2 m² subregion, reversed
cyclic correspondences, source mismatches, missing scale, false/unknown plane
membership, nonfinite/degenerate/crossed controls, holes and horizon/extrapolation
rejection. HTTP tests exercise real local PostgreSQL review persistence and
idempotency using synthetic source metadata and mocked infrastructure. No real
image upload, external provider dispatch or paid call is part of verification.
Existing feature/data/model/budget gates remain unchanged and disabled until
their separately reviewed activation.
