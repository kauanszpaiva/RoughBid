import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import type { PlansFitMode } from '../types';
import { clampZoom, computeFitPageZoom, computeFitWidthZoom } from '../utils/viewport';

type ViewportOptions = {
  pageWidth: number;
  pageHeight: number;
  totalHorizontalPadding?: number;
  totalVerticalPadding?: number;
  initialZoom?: number;
};

type PanState = {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function useBlueprintViewport({
  pageWidth,
  pageHeight,
  totalHorizontalPadding = 32,
  totalVerticalPadding = 32,
  initialZoom = 100,
}: ViewportOptions) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(clampZoom(initialZoom));
  const panRef = useRef<PanState | null>(null);
  const spaceHeldRef = useRef(false);
  const [zoomPercent, setZoomPercent] = useState(() => clampZoom(initialZoom));
  const [fitMode, setFitModeState] = useState<PlansFitMode>('manual');
  const [handTool, setHandTool] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

  const applyZoom = useCallback((next: number, mode: PlansFitMode = 'manual') => {
    const clamped = clampZoom(next);
    zoomRef.current = clamped;
    setZoomPercent(clamped);
    setFitModeState(mode);
  }, []);

  const setManualZoom = useCallback((next: number) => applyZoom(next, 'manual'), [applyZoom]);

  const setFitMode = useCallback((mode: PlansFitMode) => {
    setFitModeState(mode);
  }, []);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => setViewportSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (fitMode === 'manual' || viewportSize.width <= 0 || viewportSize.height <= 0 || pageWidth <= 0 || pageHeight <= 0) return;
    const next = fitMode === 'width'
      ? computeFitWidthZoom({ pageWidth, viewportWidth: viewportSize.width, totalHorizontalPadding })
      : computeFitPageZoom({
          pageWidth,
          pageHeight,
          viewportWidth: viewportSize.width,
          viewportHeight: viewportSize.height,
          totalHorizontalPadding,
          totalVerticalPadding,
        });
    zoomRef.current = next;
    setZoomPercent(next);
  }, [fitMode, pageWidth, pageHeight, totalHorizontalPadding, totalVerticalPadding, viewportSize.height, viewportSize.width]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || isEditableTarget(event.target)) return;
      event.preventDefault();
      spaceHeldRef.current = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') spaceHeldRef.current = false;
    };
    const onBlur = () => {
      spaceHeldRef.current = false;
      panRef.current = null;
      setIsPanning(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const onWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const element = viewportRef.current;
    if (!element) return;
    const oldZoom = zoomRef.current;
    const direction = event.deltaY > 0 ? -1 : 1;
    const nextZoom = clampZoom(oldZoom + direction * 10);
    if (nextZoom === oldZoom) return;
    const rect = element.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const contentX = element.scrollLeft + pointerX;
    const contentY = element.scrollTop + pointerY;
    applyZoom(nextZoom, 'manual');
    const ratio = nextZoom / oldZoom;
    requestAnimationFrame(() => {
      element.scrollLeft = contentX * ratio - pointerX;
      element.scrollTop = contentY * ratio - pointerY;
    });
  }, [applyZoom]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const shouldPan = event.button === 1 || (event.button === 0 && (handTool || spaceHeldRef.current));
    if (!shouldPan) return;
    const element = viewportRef.current;
    if (!element) return;
    event.preventDefault();
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: element.scrollLeft,
      scrollTop: element.scrollTop,
    };
    try { element.setPointerCapture(event.pointerId); } catch { /* capture is best-effort */ }
    setIsPanning(true);
  }, [handTool]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    const element = viewportRef.current;
    if (!pan || !element || pan.pointerId !== event.pointerId) return;
    event.preventDefault();
    element.scrollLeft = pan.scrollLeft - (event.clientX - pan.startX);
    element.scrollTop = pan.scrollTop - (event.clientY - pan.startY);
  }, []);

  const endPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    const element = viewportRef.current;
    try {
      if (element?.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    } catch { /* release is best-effort */ }
    panRef.current = null;
    setIsPanning(false);
  }, []);

  return {
    viewportRef,
    zoomPercent,
    fitMode,
    handTool,
    isPanning,
    setManualZoom,
    setFitMode,
    setHandTool,
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp: endPan,
  };
}
