import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import {
  extractDrawingLinework,
  lineworkSpaceFindings,
  mergeLineworkFindings,
} from '../src/ai-plan/drawing-linework.ts';

/**
 * A plan drawn the way a plan is drawn: rooms are four wall lines, not one
 * closed path, and a doorway is a wall that stops and starts again. Nothing here
 * is labelled, which is the point — a closet has no printed name, so a reading
 * that only understands text cannot see it at all.
 *
 *   +-----------------------------------+
 *   |  +----+                           |
 *   |  |clos|                           |
 *   |  +----+                           |
 *   |             || door gap ||        |
 *   +-----------------------------------+
 */
async function planWithRoomsAndDoorway(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const wall = (x1: number, y1: number, x2: number, y2: number) =>
    // A wall is drawn with real thickness. A drafting hairline is not a wall, and
    // the detector relies on that to keep the rules of a schedule table from
    // becoming rooms, so a fixture that drew walls as hairlines would be testing
    // something no drawing does.
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 4 });
  // Outer walls.
  wall(60, 60, 552, 60);
  wall(552, 60, 552, 732);
  wall(552, 732, 60, 732);
  wall(60, 732, 60, 60);
  // A divider with a 40 point doorway in it: the wall stops at y=376 and resumes at y=416.
  wall(306, 60, 306, 376);
  wall(306, 416, 306, 732);
  // A closet in the west room, unlabelled.
  wall(100, 620, 140, 620);
  wall(140, 620, 140, 660);
  wall(140, 660, 100, 660);
  wall(100, 660, 100, 620);
  return new Uint8Array(await doc.save());
}

test('a doorway is found where a wall run stops and resumes', async () => {
  const linework = await extractDrawingLinework(await planWithRoomsAndDoorway());
  const openings = linework.pages[0]!.openings;
  assert.equal(openings.length, 1);
  assert.equal(openings[0]!.orientation, 'vertical');
  // The clear width of the gap, measured from the drawing rather than assumed.
  assert.ok(Math.abs(openings[0]!.widthPoints - 40) <= 1, `expected ~40 pt, measured ${openings[0]!.widthPoints}`);
});

test('rooms and an unlabelled closet come out as separate spaces, not one circulation zone', async () => {
  const linework = await extractDrawingLinework(await planWithRoomsAndDoorway());
  const spaces = linework.pages[0]!.spaces;
  // Two rooms plus the inside of the closet. Without closing the doorway first
  // the flood fill would return a single space covering the whole floor.
  assert.ok(spaces.length >= 3, `expected at least 3 spaces, found ${spaces.length}`);
  // The space outside the outer walls reaches the sheet border and is dropped.
  assert.ok(spaces.every(space => space.areaFraction < 0.5), 'the world outside the building must not be reported as a room');
  // The closet sits at x 100-140, y 620-660 on a 612x792 sheet. Bounding boxes are
  // measured down from the top of the displayed page, so that is roughly 0.17
  // across and 0.17 down, about 38x37 points.
  const closet = spaces.find(space => space.bbox[0] > 0.1 && space.bbox[0] < 0.3 && space.bbox[1] > 0.1 && space.bbox[1] < 0.25);
  assert.ok(closet, `no space found over the closet; spaces were ${JSON.stringify(spaces.map(space => space.bbox))}`);
  assert.ok(closet!.widthPoints < 200 && closet!.heightPoints < 200, 'the closet should be a small space, not a room-sized one');
});

test('spaces and openings become reviewable findings that carry no invented quantity', async () => {
  const linework = await extractDrawingLinework(await planWithRoomsAndDoorway());
  const findings = lineworkSpaceFindings(linework);
  assert.ok(findings.some(finding => /enclosed space/.test(finding.label ?? '')), 'a space finding is expected');
  assert.ok(findings.some(finding => /Wall opening/.test(finding.label ?? '')), 'an opening finding is expected');
  for (const finding of findings) {
    // A location is not a takeoff: no scale has been verified, so no quantity.
    assert.equal(finding.quantity, null);
    assert.equal(finding.unit, null);
    assert.equal(finding.geometry.coordinate_space, 'normalized');
    assert.equal(finding.geometry.bbox.length, 4);
    assert.ok(finding.source_excerpt && finding.source_excerpt.length > 20);
  }
  const opening = findings.find(finding => /Wall opening/.test(finding.label ?? ''))!;
  assert.match(opening.source_excerpt, /wall run stops and resumes/);
  assert.match(opening.label!, /40 pt wide/);
});

test('the added geometry is disclosed, and a closet-sized space is never squeezed out by large rooms', async () => {
  const linework = await extractDrawingLinework(await planWithRoomsAndDoorway());
  const merged = mergeLineworkFindings([], linework, { pageCount: 1 });
  assert.ok(merged.added >= 4, `expected the spaces and the opening to be added, added ${merged.added}`);
  assert.match(merged.note!, /space\(s\) enclosed by the drawn walls/);
  assert.match(merged.note!, /wall opening\(s\)/);
  assert.match(merged.note!, /no scale was applied/);

  // The budget is split: with room for one space only, the smallest still gets a slot.
  const onlyOne = lineworkSpaceFindings(linework, { maxSpaces: 1, maxOpenings: 0 });
  assert.equal(onlyOne.length, 1);
  assert.ok(onlyOne[0]!.label!.length > 0);
});
