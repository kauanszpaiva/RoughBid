import type { NormalizedPoint } from '../types.ts';

export const clampZoom = (percent: number) => Math.min(500, Math.max(25, Math.round(percent)));

export function computeFitWidthZoom(input: { pageWidth: number; viewportWidth: number; totalHorizontalPadding: number }) {
  if (input.pageWidth <= 0 || input.viewportWidth <= input.totalHorizontalPadding) return 25;
  return clampZoom(((input.viewportWidth - input.totalHorizontalPadding) / input.pageWidth) * 100);
}

export function computeFitPageZoom(input: { pageWidth: number; pageHeight: number; viewportWidth: number; viewportHeight: number; totalHorizontalPadding: number; totalVerticalPadding: number }) {
  if (input.pageWidth <= 0 || input.pageHeight <= 0 || input.viewportWidth <= input.totalHorizontalPadding || input.viewportHeight <= input.totalVerticalPadding) return 25;
  const widthScale = (input.viewportWidth - input.totalHorizontalPadding) / input.pageWidth;
  const heightScale = (input.viewportHeight - input.totalVerticalPadding) / input.pageHeight;
  return clampZoom(Math.min(widthScale, heightScale) * 100);
}

export function computeBoxFocusZoom(input: { boxWidth: number; boxHeight: number; currentZoom: number }) {
  if (input.boxWidth <= 0 || input.boxHeight <= 0) return clampZoom(input.currentZoom);
  return clampZoom(Math.min(0.72 / input.boxWidth, 0.72 / input.boxHeight) * 100);
}

export function computeCenteredScrollPosition(input: {
  containerScrollLeft: number;
  containerScrollTop: number;
  containerWidth: number;
  containerHeight: number;
  pageOffsetLeft: number;
  pageOffsetTop: number;
  pageWidth: number;
  pageHeight: number;
  point: NormalizedPoint;
}) {
  const sourceX = input.containerScrollLeft + input.pageOffsetLeft + input.point.x * input.pageWidth;
  const sourceY = input.containerScrollTop + input.pageOffsetTop + input.point.y * input.pageHeight;
  return {
    left: Math.max(0, sourceX - input.containerWidth / 2),
    top: Math.max(0, sourceY - input.containerHeight / 2),
  };
}

export function getContinuousRenderWindow(input: { activePage: number; totalPages: number; radius: number }): number[] {
  const totalPages = Math.max(0, Math.floor(input.totalPages));
  if (totalPages === 0) return [];
  const activePage = Math.min(totalPages, Math.max(1, Math.floor(input.activePage)));
  const radius = Math.max(0, Math.floor(input.radius));
  const start = Math.max(1, activePage - radius);
  const end = Math.min(totalPages, activePage + radius);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export function pickActivePage(entries: Array<{ page: number; ratio: number }>): number | null {
  let active: { page: number; ratio: number } | null = null;
  for (const entry of entries) {
    if (!Number.isInteger(entry.page) || entry.page < 1 || !Number.isFinite(entry.ratio)) continue;
    if (!active || entry.ratio > active.ratio) active = entry;
  }
  return active?.page ?? null;
}
