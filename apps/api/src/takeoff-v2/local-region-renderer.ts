import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { StageRuntimeSources, StageSourceImage } from './stage-provider.ts';
import type { StageFactoryInput, StageRegion } from './stage-regions.ts';
import type { DeepPassRequest } from './types.ts';
import { normalizedPdfRotation } from './pdf-orientation.ts';

const MAX_REGION_PDF_BYTES = 10 * 1024 * 1024;
const MAX_REGION_JPEG_BYTES = 12 * 1024 * 1024;
const TEMP_PREFIX = 'roughbid-region-';
export const MAX_REGION_IMAGE_EDGE_PIXELS = 1300;
export type LocalRegionRenderer = NonNullable<StageRuntimeSources['renderRegion']>;
export interface LocalRegionProcessOptions {
  timeout: number;
  maxBuffer: number;
  windowsHide: true;
  shell: false;
  env: NodeJS.ProcessEnv;
}
export interface LocalRegionRendererDependencies {
  runProcess?(command: string, args: readonly string[], options: LocalRegionProcessOptions): Promise<void>;
  tempRoot?: string;
}

/** Diagnostics contain no subprocess stderr, filesystem paths or document data. */
export class LocalRegionRenderError extends Error {
  readonly code: 'region_render_config_invalid' | 'region_render_input_invalid' | 'region_render_failed' | 'region_render_output_invalid';
  constructor(code: LocalRegionRenderError['code']) {
    super('Local region rendering requires a valid PDF crop and a verified bounded JPEG.');
    this.name = 'LocalRegionRenderError';
    this.code = code;
  }
}
function fail(code: LocalRegionRenderError['code']): never { throw new LocalRegionRenderError(code); }
function configuredInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail('region_render_config_invalid');
  return value;
}
function publicProcessEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  // Poppler needs executable/font paths, not the worker's provider credentials.
  for (const name of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR',
    'TEMP', 'TMP', 'TMPDIR', 'LD_LIBRARY_PATH', 'FONTCONFIG_PATH', 'FONTCONFIG_FILE', 'LANG', 'LC_ALL']) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}
async function executeLocalProcess(command: string, args: readonly string[], options: LocalRegionProcessOptions): Promise<void> {
  await new Promise<void>((accept, reject) => {
    execFile(command, [...args], options, error => error ? reject(new LocalRegionRenderError('region_render_failed')) : accept());
  });
}
function samePoint(actual: number, expected: number): boolean { return Math.abs(actual - expected) <= 0.01; }

async function validateRegion(input: StageFactoryInput, request: DeepPassRequest, stage: StageRegion): Promise<void> {
  const sheet = input.manifest.sheets.find(item => item.physicalPageNumber === request.sheet.physicalPageNumber);
  const region = stage.region;
  if (input.runId !== request.runId || !sheet || sheet.pageSha256 !== request.sheet.pageSha256
    || request.sheet.rotationDegrees !== sheet.rotationDegrees || stage.rotationDegrees !== sheet.rotationDegrees
    || !Number.isSafeInteger(request.sheet.physicalPageNumber) || request.sheet.physicalPageNumber < 1
    || ![2, 3].includes(region.rows) || region.rows !== region.columns
    || !Number.isSafeInteger(region.row) || region.row < 1 || region.row > region.rows
    || !Number.isSafeInteger(region.column) || region.column < 1 || region.column > region.columns
    || stage.id !== `r${region.row}c${region.column}g${region.rows}`
    || ![region.x, region.y, region.width, region.height, stage.pageWidthPoints, stage.pageHeightPoints].every(Number.isFinite)
    || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0
    || stage.pageWidthPoints <= 0 || stage.pageHeightPoints <= 0
    || region.x + region.width > stage.pageWidthPoints + 0.01 || region.y + region.height > stage.pageHeightPoints + 0.01
    || !(stage.pdfBytes instanceof Uint8Array) || stage.pdfBytes.byteLength === 0 || stage.pdfBytes.byteLength > MAX_REGION_PDF_BYTES) {
    fail('region_render_input_invalid');
  }
  try {
    // Encrypted PDFs are rejected here; bypassing encryption is not a render capability.
    const document = await PDFDocument.load(stage.pdfBytes.slice(), { updateMetadata: false });
    if (document.getPageCount() !== 1) fail('region_render_input_invalid');
    const page = document.getPage(0);
    const crop = page.getCropBox();
    const media = page.getMediaBox();
    if (normalizedPdfRotation(page.getRotation().angle) !== sheet.rotationDegrees || !samePoint(crop.width, region.width) || !samePoint(crop.height, region.height)
      || !samePoint(crop.x,stage.sourceFrame.x+region.x) || !samePoint(crop.y,stage.sourceFrame.y+region.y)
      || ![crop.x, crop.y, crop.width, crop.height, media.x, media.y, media.width, media.height].every(Number.isFinite)
      || crop.x < media.x - 0.01 || crop.y < media.y - 0.01
      || crop.x + crop.width > media.x + media.width + 0.01 || crop.y + crop.height > media.y + media.height + 0.01) {
      fail('region_render_input_invalid');
    }
  } catch { fail('region_render_input_invalid'); }
}

/** Read the actual JPEG SOF dimensions, never a requested resolution or filename. */
export function readRegionJpegDimensions(bytes: Uint8Array): { widthPixels: number; heightPixels: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) fail('region_render_output_invalid');
  let position = 2;
  while (position < bytes.length - 2) {
    if (bytes[position] !== 0xff) fail('region_render_output_invalid');
    while (bytes[position] === 0xff) position++;
    const marker = bytes[position++];
    if (marker === undefined || marker === 0x00 || marker === 0xd8 || marker === 0xd9 || marker === 0xda) fail('region_render_output_invalid');
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (position + 2 > bytes.length - 2) fail('region_render_output_invalid');
    const length = ((bytes[position] ?? 0) << 8) | (bytes[position + 1] ?? 0);
    if (length < 2 || position + length > bytes.length - 2) fail('region_render_output_invalid');
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) fail('region_render_output_invalid');
      const heightPixels = ((bytes[position + 3] ?? 0) << 8) | (bytes[position + 4] ?? 0);
      const widthPixels = ((bytes[position + 5] ?? 0) << 8) | (bytes[position + 6] ?? 0);
      const components = bytes[position + 7] ?? 0;
      if (widthPixels < 1 || heightPixels < 1 || ![1, 3, 4].includes(components) || length !== 8 + 3 * components) fail('region_render_output_invalid');
      return { widthPixels, heightPixels };
    }
    position += length;
  }
  fail('region_render_output_invalid');
}

async function cleanOwnedDirectory(tempRoot: string, directory: string): Promise<void> {
  const target = resolve(directory);
  // A recursive remove is permitted only for the exact unique child we created.
  if (dirname(target) !== tempRoot || !basename(target).startsWith(TEMP_PREFIX) || target === tempRoot) fail('region_render_failed');
  await rm(target, { recursive: true, force: true });
}

/** Optional local-only crop hook. This function never uploads or calls a provider. */
export function createLocalRegionRenderer(
  env: Readonly<Record<string, string | undefined>>,
  dependencies: LocalRegionRendererDependencies = {},
): LocalRegionRenderer | undefined {
  const enabled = env.TAKEOFF_V2_REGIONAL_REVIEW_ENABLED;
  if (enabled === undefined || enabled === '' || enabled === 'false') return undefined;
  if (enabled !== 'true') fail('region_render_config_invalid');
  const timeout = configuredInteger(env.TAKEOFF_V2_REGION_RENDER_TIMEOUT_MS, 30_000, 1_000, 60_000);
  const maxEdge = configuredInteger(env.TAKEOFF_V2_REGION_RENDER_MAX_EDGE_PX, MAX_REGION_IMAGE_EDGE_PIXELS, 256, MAX_REGION_IMAGE_EDGE_PIXELS);
  const command = env.TAKEOFF_V2_POPPLER_BINARY ?? 'pdftoppm';
  if (!command.trim() || /[\r\n\0]/.test(command)) fail('region_render_config_invalid');
  const runProcess = dependencies.runProcess ?? executeLocalProcess;
  return async (input, request, stage): Promise<StageSourceImage> => {
    await validateRegion(input, request, stage);
    let directory: string | undefined;
    let tempRoot: string | undefined;
    try {
      tempRoot = await realpath(resolve(dependencies.tempRoot ?? tmpdir()));
      directory = await mkdtemp(join(tempRoot, TEMP_PREFIX));
      const source = join(directory, 'source.pdf');
      const outputPrefix = join(directory, 'crop');
      await writeFile(source, stage.pdfBytes, { mode: 0o600, flag: 'wx' });
      await runProcess(command, ['-f', '1', '-l', '1', '-singlefile', '-cropbox', '-jpeg', '-jpegopt',
        'quality=92,progressive=y,optimize=y', '-scale-to', String(maxEdge), source, outputPrefix],
      { timeout, maxBuffer: 64 * 1024, windowsHide: true, shell: false, env: publicProcessEnvironment() });
      const output = join(directory, 'crop.jpg');
      const metadata = await lstat(output);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0 || metadata.size > MAX_REGION_JPEG_BYTES) fail('region_render_output_invalid');
      const bytes = await readFile(output);
      if (bytes.byteLength !== metadata.size || bytes.byteLength > MAX_REGION_JPEG_BYTES) fail('region_render_output_invalid');
      const dimensions = readRegionJpegDimensions(bytes);
      if (Math.max(dimensions.widthPixels, dimensions.heightPixels) > maxEdge) fail('region_render_output_invalid');
      // Poppler honors the original /Rotate: quarter turns swap displayed axes.
      const pointEdge = Math.max(stage.region.width, stage.region.height);
      const pixelEdge = Math.max(dimensions.widthPixels, dimensions.heightPixels);
      const quarter=stage.rotationDegrees===90||stage.rotationDegrees===270;
      const displayWidth=quarter?stage.region.height:stage.region.width,displayHeight=quarter?stage.region.width:stage.region.height;
      if (Math.abs(dimensions.widthPixels - displayWidth / pointEdge * pixelEdge) > 1.5
        || Math.abs(dimensions.heightPixels - displayHeight / pointEdge * pixelEdge) > 1.5) fail('region_render_output_invalid');
      return { dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`, ...dimensions,
        label: `Physical page ${request.sheet.physicalPageNumber}, verified local crop ${stage.id}`,
        pageNumber: request.sheet.physicalPageNumber, region: { ...stage.region },rotationDegrees:stage.rotationDegrees,displayRegion:stage.displayRegion };
    } catch (error) {
      if (error instanceof LocalRegionRenderError) throw error;
      fail('region_render_failed');
    } finally {
      if (directory && tempRoot) {
        try { await cleanOwnedDirectory(tempRoot, directory); }
        catch { fail('region_render_failed'); }
      }
    }
  };
}
