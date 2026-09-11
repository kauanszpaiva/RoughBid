import { useCallback, useEffect, useRef } from 'react';
import type { PlanReadingFinding } from '../../../services/api';
import type { FindingTarget, NormalizedPoint } from '../types';
import { getFindingTarget } from '../utils/findingGeometry';
import { computeBoxFocusZoom, computeCenteredScrollPosition } from '../utils/viewport';

type Options = {
  pdfPageCount: number;
  activePage: number;
  currentZoom: number;
  setActivePage: (page: number) => void;
  setManualZoom: (zoom: number) => void;
  setSelectedFindingId: (findingId: string | null) => void;
  getScrollContainer: () => HTMLElement | null;
  getPageElement: (page: number) => HTMLElement | null;
};

type PendingTarget = { findingId: string; target: FindingTarget };

function targetPoint(target: FindingTarget): NormalizedPoint | null {
  if (target.kind === 'point') return target.point;
  if (target.kind === 'box') {
    return {
      x: target.box[0] + target.box[2] / 2,
      y: target.box[1] + target.box[3] / 2,
    };
  }
  return null;
}

export function useFindingNavigation({
  pdfPageCount,
  activePage,
  currentZoom,
  setActivePage,
  setManualZoom,
  setSelectedFindingId,
  getScrollContainer,
  getPageElement,
}: Options) {
  const pendingRef = useRef<PendingTarget | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPendingTimer = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);

  const centerPending = useCallback(() => {
    cancelPendingTimer();
    let attempts = 0;
    const tryCenter = () => {
      const pending = pendingRef.current;
      if (!pending) return;
      const container = getScrollContainer();
      const pageElement = getPageElement(pending.target.page);
      if (!container || !pageElement || pageElement.dataset.renderStatus !== 'ready') {
        attempts += 1;
        if (attempts < 100) timeoutRef.current = setTimeout(tryCenter, 50);
        return;
      }

      const point = targetPoint(pending.target);
      if (!point) {
        pageElement.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
        pendingRef.current = null;
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const pageRect = pageElement.getBoundingClientRect();
      const next = computeCenteredScrollPosition({
        containerScrollLeft: container.scrollLeft,
        containerScrollTop: container.scrollTop,
        containerWidth: container.clientWidth,
        containerHeight: container.clientHeight,
        pageOffsetLeft: pageRect.left - containerRect.left,
        pageOffsetTop: pageRect.top - containerRect.top,
        pageWidth: pageRect.width,
        pageHeight: pageRect.height,
        point,
      });
      container.scrollTo({ ...next, behavior: 'smooth' });
      pendingRef.current = null;
    };
    tryCenter();
  }, [cancelPendingTimer, getPageElement, getScrollContainer]);

  useEffect(() => {
    if (pendingRef.current?.target.page === activePage) centerPending();
  }, [activePage, currentZoom, centerPending]);

  useEffect(() => cancelPendingTimer, [cancelPendingTimer]);

  const focusFinding = useCallback((finding: PlanReadingFinding) => {
    const target = getFindingTarget(finding, pdfPageCount);
    if (!target) return false;
    pendingRef.current = { findingId: finding.id, target };
    setSelectedFindingId(finding.id);
    setActivePage(target.page);
    if (target.kind === 'box') {
      setManualZoom(computeBoxFocusZoom({
        boxWidth: target.box[2],
        boxHeight: target.box[3],
        currentZoom,
      }));
    } else {
      centerPending();
    }
    return true;
  }, [centerPending, currentZoom, pdfPageCount, setActivePage, setManualZoom, setSelectedFindingId]);

  const clearFinding = useCallback(() => {
    pendingRef.current = null;
    cancelPendingTimer();
    setSelectedFindingId(null);
  }, [cancelPendingTimer, setSelectedFindingId]);

  return { focusFinding, clearFinding };
}
