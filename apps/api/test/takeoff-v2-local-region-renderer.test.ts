import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { PDFDocument, degrees } from 'pdf-lib';
import { createLocalRegionRenderer, LocalRegionRenderError, readRegionJpegDimensions,
  type LocalRegionRendererDependencies, type LocalRegionProcessOptions } from '../src/takeoff-v2/local-region-renderer.ts';
import { createPlanSetManifest } from '../src/takeoff-v2/preflight.ts';
import { isolateStageRegions, type StageRegion } from '../src/takeoff-v2/stage-regions.ts';
import type { DeepPassRequest } from '../src/takeoff-v2/types.ts';

const enabled = { TAKEOFF_V2_REGIONAL_REVIEW_ENABLED: 'true' };
function jpeg(width: number, height: number): Uint8Array {
  // A SOF header fixture; production dimensions are read from Poppler's JPEG.
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02,
    0xff, 0xc2, 0x00, 0x11, 8, height >> 8, height & 255, width >> 8, width & 255, 3,
    1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
}
async function fixture(cropWidth = 800, cropHeight = 540,rotation:0|90|180|270=0) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([cropWidth + 40, cropHeight + 60]);
  page.setCropBox(20, 30, cropWidth, cropHeight);
  page.setRotation(degrees(rotation));
  const fileBytes = new Uint8Array(await pdf.save());
  const manifest = await createPlanSetManifest(fileBytes);
  const input = { fileBytes, manifest, runId: 'run-1', workspaceId: 'workspace-1', projectId: 'project-1', fileId: 'file-1', leaseId: 'lease-1' };
  const request: DeepPassRequest = { runId: input.runId, sheet: manifest.sheets[0]!, passType: 'discipline',
    attempt: 1, idempotencyKey: 'local-render-test', reasoningEffort: 'high' };
  const region = (await isolateStageRegions(fileBytes, 2))[0]!;
  return { input, request, region };
}
async function temporaryRoot(): Promise<{ root: string; remove: () => Promise<void> }> {
  const parent = await realpath(resolve(tmpdir()));
  const root = await mkdtemp(join(parent, 'roughbid-region-test-'));
  return { root, remove: async () => {
    const target = resolve(root);
    assert.equal(dirname(target), parent); assert.ok(basename(target).startsWith('roughbid-region-test-'));
    await rm(target, { recursive: true, force: true });
  } };
}
function processMock(stage: StageRegion, options: {
  dimensions?: [number, number]; reject?: boolean; missing?: boolean;
} = {}): { dependencies: LocalRegionRendererDependencies; calls: Array<{ command: string; args: readonly string[]; options: LocalRegionProcessOptions }> } {
  const calls: Array<{ command: string; args: readonly string[]; options: LocalRegionProcessOptions }> = [];
  return { calls, dependencies: { runProcess: async (command, args, configuration) => {
    calls.push({ command, args, options: configuration });
    if (options.reject) throw new Error('private filename and provider credential in hypothetical stderr');
    if (options.missing) return;
    const width = options.dimensions?.[0] ?? 1300;
    const height = options.dimensions?.[1] ?? Math.round(width * stage.region.height / stage.region.width);
    await writeFile(`${args.at(-1)}.jpg`, jpeg(width, height));
  } } };
}

test('regional renderer is opt-in and refuses invalid local limits', () => {
  assert.equal(createLocalRegionRenderer({}), undefined);
  assert.equal(createLocalRegionRenderer({ TAKEOFF_V2_REGIONAL_REVIEW_ENABLED: 'false' }), undefined);
  for (const configuration of [
    { TAKEOFF_V2_REGIONAL_REVIEW_ENABLED: 'yes' },
    { ...enabled, TAKEOFF_V2_REGION_RENDER_MAX_EDGE_PX: '1301' },
    { ...enabled, TAKEOFF_V2_REGION_RENDER_TIMEOUT_MS: '60001' },
    { ...enabled, TAKEOFF_V2_REGION_RENDER_TIMEOUT_MS: '10e3' },
    { ...enabled, TAKEOFF_V2_POPPLER_BINARY: '\ncommand' },
  ]) assert.throws(() => createLocalRegionRenderer(configuration), (error: unknown) => error instanceof LocalRegionRenderError && error.code === 'region_render_config_invalid');
});

test('local Poppler contract uses CropBox, verifies dimensions, labels physical page and cleans unique files', async () => {
  const { input, request, region } = await fixture(); const temp = await temporaryRoot();
  try {
    const mock = processMock(region);
    const renderer = createLocalRegionRenderer({ ...enabled, OPENAI_API_KEY: 'unit-secret-not-for-child', TAKEOFF_V2_REGION_RENDER_TIMEOUT_MS: '1000' },
      { ...mock.dependencies, tempRoot: temp.root })!;
    const image = await renderer(input, request, region);
    assert.equal(mock.calls.length, 1);
    const { args, options } = mock.calls[0]!;
    assert.equal(mock.calls[0]!.command, 'pdftoppm');
    assert.deepEqual(args.slice(0, 12), ['-f', '1', '-l', '1', '-singlefile', '-cropbox', '-jpeg', '-jpegopt', 'quality=92,progressive=y,optimize=y', '-scale-to', '1300', args[11]]);
    assert.equal(options.timeout, 1000); assert.equal(options.windowsHide, true); assert.equal(options.shell, false);
    assert.equal(options.env.OPENAI_API_KEY, undefined); assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(options.env.GEMINI_API_KEY, undefined); assert.equal(options.env.SUPABASE_SERVICE_ROLE_KEY, undefined);
    assert.match(image.dataUrl, /^data:image\/jpeg;base64,/);
    const measured = readRegionJpegDimensions(Buffer.from(image.dataUrl.split(',')[1]!, 'base64'));
    assert.equal(image.widthPixels, measured.widthPixels); assert.equal(image.heightPixels, measured.heightPixels);
    assert.equal(image.pageNumber, 1); assert.deepEqual(image.region, region.region); assert.notEqual(image.region, region.region);
    assert.match(image.label!, /Physical page 1, verified local crop r1c1g2/);
    await assert.rejects(access(dirname(args.at(-1)!)));
  } finally { await temp.remove(); }
});

test('each simultaneous crop receives independent temporary paths and both are cleaned', async () => {
  const { input, request, region } = await fixture(); const temp = await temporaryRoot();
  try {
    const mock = processMock(region);
    const renderer = createLocalRegionRenderer(enabled, { ...mock.dependencies, tempRoot: temp.root })!;
    await Promise.all([renderer(input, request, region), renderer(input, request, region)]);
    assert.equal(mock.calls.length, 2); assert.notEqual(mock.calls[0]!.args.at(-1), mock.calls[1]!.args.at(-1));
    for (const call of mock.calls) await assert.rejects(access(dirname(call.args.at(-1)!)));
  } finally { await temp.remove(); }
});

test('no subprocess runs for cross-run, changed sheet, invalid region or mismatched rotation', async () => {
  const { input, request, region } = await fixture(); const mock = processMock(region);
  const renderer = createLocalRegionRenderer(enabled, mock.dependencies)!;
  for (const [candidateRequest, candidateRegion] of [
    [{ ...request, runId: 'other-run' }, region],
    [{ ...request, sheet: { ...request.sheet, pageSha256: 'other-sha' } }, region],
    [{ ...request, sheet: { ...request.sheet, rotationDegrees: 90 } }, region],
    [request, { ...region, region: { ...region.region, width: -1 } }],
    [request, { ...region, id: 'unsafe-name' }],
    [request, { ...region, region: { ...region.region, x: region.pageWidthPoints } }],
  ] as Array<[DeepPassRequest, StageRegion]>) {
    await assert.rejects(renderer(input, candidateRequest, candidateRegion), (error: unknown) => error instanceof LocalRegionRenderError && error.code === 'region_render_input_invalid');
  }
  assert.equal(mock.calls.length, 0);
});

test('PDF page count, PDF rotation and CropBox dimensions are checked before rendering', async () => {
  const { input, request, region } = await fixture(); const mock = processMock(region);
  const renderer = createLocalRegionRenderer(enabled, mock.dependencies)!;
  const differentCrop = await PDFDocument.load(region.pdfBytes); differentCrop.getPage(0).setCropBox(0, 0, 100, 100);
  const rotated = await PDFDocument.load(region.pdfBytes); rotated.getPage(0).setRotation(degrees(90));
  const multipage = await PDFDocument.load(region.pdfBytes); multipage.addPage();
  for (const bytes of [await differentCrop.save(), await rotated.save(), await multipage.save(), Uint8Array.of(1, 2, 3)]) {
    await assert.rejects(renderer(input, request, { ...region, pdfBytes: new Uint8Array(bytes) }), LocalRegionRenderError);
  }
  assert.equal(mock.calls.length, 0);
});

test('renderer failure is sanitized and cleanup completes before rejecting', async () => {
  const { input, request, region } = await fixture(); const temp = await temporaryRoot();
  try {
    const mock = processMock(region, { reject: true });
    const renderer = createLocalRegionRenderer(enabled, { ...mock.dependencies, tempRoot: temp.root })!;
    await assert.rejects(renderer(input, request, region), (error: unknown) => {
      assert.ok(error instanceof LocalRegionRenderError); assert.equal(error.code, 'region_render_failed');
      assert.doesNotMatch(error.message, /private|credential|roughbid-region|source\.pdf/); return true;
    });
    await assert.rejects(access(dirname(mock.calls[0]!.args.at(-1)!)));
  } finally { await temp.remove(); }
});

test('oversize, wrong aspect ratio, missing and malformed renderer outputs are blocked and cleaned', async () => {
  const { input, request, region } = await fixture(); const temp = await temporaryRoot();
  try {
    for (const configuration of [{ dimensions: [1301, 900] as [number, number] }, { dimensions: [500, 500] as [number, number] }, { missing: true }]) {
      const mock = processMock(region, configuration);
      const renderer = createLocalRegionRenderer(enabled, { ...mock.dependencies, tempRoot: temp.root })!;
      await assert.rejects(renderer(input, request, region), LocalRegionRenderError);
      await assert.rejects(access(dirname(mock.calls[0]!.args.at(-1)!)));
    }
    const renderer = createLocalRegionRenderer(enabled, { tempRoot: temp.root, runProcess: async (_command, args) => {
      await writeFile(`${args.at(-1)}.jpg`, Uint8Array.of(1, 2, 3));
    } })!;
    await assert.rejects(renderer(input, request, region), (error: unknown) => error instanceof LocalRegionRenderError && error.code === 'region_render_output_invalid');
  } finally { await temp.remove(); }
});

test('JPEG header validation rejects absent SOF, incomplete segments and zero dimensions', () => {
  assert.deepEqual(readRegionJpegDimensions(jpeg(1234, 876)), { widthPixels: 1234, heightPixels: 876 });
  for (const bytes of [Uint8Array.of(0xff, 0xd8, 0xff, 0xd9), jpeg(0, 100), jpeg(100, 0), jpeg(100, 100).slice(0, 14),
    Uint8Array.of(0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9)]) assert.throws(() => readRegionJpegDimensions(bytes), LocalRegionRenderError);
});

test('installed Poppler locally renders the actual CropBox with verified bounded dimensions', async t => {
  const available = await new Promise<boolean>(accept => execFile('pdftoppm', ['-v'], { windowsHide: true, timeout: 1000 }, error => accept(!error)));
  if (!available) { t.skip('Poppler is not installed in this test environment.'); return; }
  const temp = await temporaryRoot();
  try {
    const renderer = createLocalRegionRenderer(enabled, { tempRoot: temp.root })!;
    for (const [width, height,rotation] of [[800,540,0],[800,83,0],[83,800,0],[800,540,90],[800,540,180],[800,540,270]] as const) {
      const { input, request, region } = await fixture(width, height,rotation);
      const image = await renderer(input, request, region);
      assert.ok((image.widthPixels ?? 0) > 0); assert.ok((image.heightPixels ?? 0) > 0);
      assert.equal(Math.max(image.widthPixels!, image.heightPixels!), 1300);
      assert.deepEqual(readRegionJpegDimensions(Buffer.from(image.dataUrl.split(',')[1]!, 'base64')),
        { widthPixels: image.widthPixels, heightPixels: image.heightPixels });
      assert.equal(image.pageNumber, request.sheet.physicalPageNumber);
      assert.equal(image.rotationDegrees,rotation);
      assert.ok(Math.abs(image.widthPixels!/image.heightPixels!-region.displayRegion.width/region.displayRegion.height)<0.01);
    }
  } finally { await temp.remove(); }
});
