import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DIMENSION_TOLERANCE_INCHES,
  claimedWindowTypes,
  compareWindowTypes,
  describeOpeningConflictNotice,
  drawnRoughOpenings,
  formatInchesAsFeetInches,
  parseFeetInchesToInches,
  reconcileOpenings,
} from '../src/ai-plan/drawing-conflicts.ts';

/**
 * These fixtures are the real strings from the North Elementary School
 * (Somerset, MA) design-development set: the window type elevations on sheet
 * A8.20 and the window lines of the 23 October 2025 cost estimate prepared from
 * them. The estimate prices two of those types at 11'-8 1/2" wide and one at
 * 2'-10 1/2" wide; the sheet prints 17'-8 1/2", 17'-9" and 5'-10 1/2".
 */
const DRAWING = {
  pages: [{
    pageNumber: 11,
    // A drawing sheet arrives as one long collapsed line far more often than as tidy rows.
    text: [
      'GL2 GL2 SIM. TYPE A1', 'VIF 10\'-6 1/2" +/- R.O.', 'VIF 8\'-2" +/- R.O.', '6\'-0" W x 8\'-0" H OPENING',
      '3\'-11" EQ EQ EQ EQ', "VIF 8'-0\" +/- R.O.", 'VIF 17\'-8 1/2" +/- R.O.', 'VIF 23\'-2" +/- R.O.',
      'VIF 4\'-0" +/- R.O.', 'VIF 11\'-7" +/- R.O.', 'VIF 7\'-8" +/- R.O.', 'VIF 8\'-2 1/2" R.O.',
      "VIF 5'-10 1/2\" R.O.", 'VIF 23\'-1 1/2" +/- R.O.', 'VIF 17\'-9" +/- R.O.',
      'TYPE H-OH - OPP HAND', '1/4" = 1\'-0"15 TYPE A1',
    ].join(' '),
  }],
};

const ESTIMATE = {
  pages: [{
    pageNumber: 9,
    text: [
      'Exterior Aluminum Entrance Doors with 1” low-E insulated glazing',
      "Window type A1/A2/A1-AC; 10'-6 1/2\" x 8'-2\" 13 ea",
      "Window type B1/B2; 4'-2 3/4\" x 8'-2\" 9 ea",
      "Window type C1/C2/C1-AC; 7'-6 1/2\" x 8'-2\" 4 ea",
      "Window type D; 11'-8 1/2\" x 8'-0\" 1 ea",
      "Window type D; 23'-2\" x 8'-0\" 1 ea",
      "Window type E; 11'-7\" x 8'-0\" 1 ea",
      "Window type E; 4'-0\" x 8'-0\" 1 ea",
      "Window type F; 7'-8\" x 8'-0\" 1 ea",
      "Window type G; 11'-8 1/2\" x 8'-0\" 1 ea",
      "Window type G; 23'-2\" x 8'-0\" 1 ea",
      "Window type H; 2'-10 1/2\" x 8'-2\" 2 ea",
      "Door type B; 6'-0\" x 7'-9 1/2\" / 8'-0\" 11 pr 9,900.00 108,900",
      "Door type B1; 5'-7\" / 5'-8 1/2\" x 7'-0\" 5 pr ETR exist to remain, no work",
    ].join(' '),
  }],
};

test('feet and inches parse and round-trip, and nonsense is refused', () => {
  assert.equal(parseFeetInchesToInches(`10'-6 1/2"`), 126.5);
  assert.equal(parseFeetInchesToInches(`8' - 0"`), 96);
  assert.equal(parseFeetInchesToInches(`8'-2"`), 98);
  assert.equal(parseFeetInchesToInches(`4'-2 3/4"`), 50.75);
  for (const value of ['', 'n/a', `8'-13"`, `8'-2 3/2"`, '8ft 2in', `-8'-0"`]) {
    assert.equal(parseFeetInchesToInches(value), null, value);
  }
  assert.equal(formatInchesAsFeetInches(140.5), `11'-8 1/2"`);
  assert.equal(formatInchesAsFeetInches(212.5), `17'-8 1/2"`);
  assert.equal(formatInchesAsFeetInches(96), `8'-0"`);
});

test('the estimate line items are read with their size, quantity and evidence', () => {
  const claims = claimedWindowTypes(ESTIMATE);
  assert.equal(claims.length, 11);
  const first = claims[0]!;
  assert.equal(first.label, 'A1/A2/A1-AC');
  assert.equal(first.widthInches, 126.5);
  assert.equal(first.heightInches, 98);
  assert.equal(first.quantity, 13);
  assert.equal(first.unit, 'ea');
  assert.equal(first.pageNumber, 9);
  // The excerpt quotes the printed line, so a reviewer can find it on the page.
  assert.match(first.sourceExcerpt, /Window type A1\/A2\/A1-AC/);
  // A door line is not a window type, and a line printing two alternative sizes
  // is skipped instead of guessed at.
  assert.equal(claims.some(claim => claim.label.startsWith('B') && claim.widthInches === 72), false);
  assert.equal(claims.filter(claim => claim.label === 'B1').length, 0);
});

test('the drawings yield every rough opening once, with the sheet that printed it', () => {
  const drawn = drawnRoughOpenings(DRAWING);
  const inches = drawn.map(entry => entry.inches).sort((a, b) => a - b);
  assert.deepEqual(inches, [48, 70.5, 92, 96, 98, 98.5, 126.5, 139, 212.5, 213, 277.5, 278]);
  assert.ok(drawn.every(entry => entry.pageNumber === 11));
  assert.ok(drawn.every(entry => entry.sourceExcerpt.includes('R.O')));
  // A size printed five times on a sheet is still one fact.
  assert.equal(new Set(drawn.map(entry => entry.inches)).size, drawn.length);
});

test('it catches the sizes the estimate prices and the drawings never print', () => {
  const comparison = reconcileOpenings({ drawing: DRAWING, document: ESTIMATE, toleranceInches: DEFAULT_DIMENSION_TOLERANCE_INCHES });
  const notDrawn = comparison.conflicts.filter(conflict => conflict.code === 'claimed_width_not_drawn');
  // B1/B2 is the strongest of these: 4'-2 3/4" appears nowhere in the drawing
  // set, in any form. D, G and H are the three real under-measurements, priced
  // at 11'-8 1/2" and 2'-10 1/2" while the drawings print 17'-8 1/2", 17'-9"
  // and 5'-10 1/2". C1/C2/C1-AC is the immaterial one: the drawings do print
  // 7'-6", just not as a rough opening, so a half inch separates the two.
  assert.deepEqual(
    notDrawn.map(conflict => [conflict.label, conflict.inches]).sort(),
    [['B1/B2', 50.75], ['C1/C2/C1-AC', 90.5], ['D', 140.5], ['G', 140.5], ['H', 34.5]].sort(),
  );
  const notClaimed = comparison.conflicts.filter(conflict => conflict.code === 'drawn_size_not_claimed');
  assert.deepEqual(notClaimed.map(conflict => conflict.inches).sort((a, b) => a - b), [70.5, 212.5, 213]);
  assert.match(notClaimed.find(conflict => conflict.inches === 212.5)!.detail, /17'-8 1\/2" rough opening/);
  assert.equal(comparison.claimedChecked, 11);
  assert.equal(comparison.drawnChecked, 12);
  // A conflict never pretends to know which opening the document meant.
  for (const conflict of comparison.conflicts) {
    assert.match(conflict.detail, /(print no rough opening|no priced type matches)/);
    assert.ok(conflict.sourceExcerpt.length > 0);
  }
});

test('the sizes both sides agree on stay silent', () => {
  const drawing = { pages: [{ pageNumber: 1, text: `VIF 17'-8 1/2" +/- R.O. VIF 8'-0" +/- R.O.` }] };
  const document = { pages: [{ pageNumber: 2, text: `Window type D; 17'-8 1/2" x 8'-0" 1 ea 3,700.00` }] };
  const comparison = reconcileOpenings({ drawing, document });
  assert.deepEqual(comparison.conflicts, []);
  assert.equal(comparison.matchedSizes, 2);
  assert.match(describeOpeningConflictNotice(comparison)!, /Every one of the 1 priced window type\(s\) matches/);
});

test('a document with no window types, or drawings with no rough openings, says nothing rather than agreeing', () => {
  // One empty side must not turn "nothing to compare" into a page of conflicts:
  // with no drawn evidence every priced size would look missing.
  const noClaims = reconcileOpenings({ drawing: DRAWING, document: { pages: [] } });
  assert.deepEqual(noClaims.conflicts, []);
  assert.equal(noClaims.drawnChecked, 12);
  assert.equal(describeOpeningConflictNotice(noClaims), null);

  const noDrawn = reconcileOpenings({ drawing: { pages: [] }, document: ESTIMATE });
  assert.deepEqual(noDrawn.conflicts, []);
  assert.equal(noDrawn.claimedChecked, 11);
  assert.equal(describeOpeningConflictNotice(noDrawn), null);

  assert.equal(describeOpeningConflictNotice(undefined), null);
  assert.equal(claimedWindowTypes(undefined).length, 0);
  assert.equal(drawnRoughOpenings(undefined).length, 0);
});

test('the disagreement is disclosed as a limitation a reviewer has to resolve', () => {
  const comparison = reconcileOpenings({ drawing: DRAWING, document: ESTIMATE });
  const notice = describeOpeningConflictNotice(comparison)!;
  assert.match(notice, new RegExp(`^${comparison.conflicts.length} disagreement\\(s\\)`));
  assert.match(notice, /must be resolved by an estimator/);
  assert.match(notice, /within 0.5"/);
});

test('the conflict list is bounded so one bad document cannot flood a reading', () => {
  const many = {
    pages: [{
      pageNumber: 1,
      text: Array.from({ length: 60 }, (_, index) => `Window type Z${index}; ${index + 1}'-1" x 8'-0" 1 ea`).join(' '),
    }],
  };
  const comparison = compareWindowTypes({ claimed: claimedWindowTypes(many), drawn: drawnRoughOpenings(DRAWING), maxConflicts: 5 });
  assert.equal(comparison.conflicts.length, 5);
});
