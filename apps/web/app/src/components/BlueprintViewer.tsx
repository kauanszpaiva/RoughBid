import React, { useRef, useState } from "react";
import {
  FileText,
  Hand,
  Info,
  Maximize2,
  MousePointer2,
  RotateCcw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { PlanRevision } from "../types";

interface BlueprintViewerProps {
  currentRevision: PlanRevision;
  projectName: string;
  previewUrl?: string | null;
  isPreviewLoading?: boolean;
  previewError?: string | null;
}

const hotspots = [
  {
    id: "dimensions",
    left: "50%",
    top: "18%",
    title: "Important dimensions",
    label: "Check sizes",
    detail: "Review measurements visible on the uploaded plan before they become quantities.",
  },
  {
    id: "scope",
    left: "36%",
    top: "38%",
    title: "Scope area",
    label: "Work zone",
    detail: "This mark sits on the real uploaded sheet. Use it to keep scope review tied to the plan.",
  },
  {
    id: "counts",
    left: "67%",
    top: "47%",
    title: "Count items",
    label: "Count symbols",
    detail: "Fixtures, doors, posts, outlets and repeated symbols should be checked visually on the PDF.",
  },
  {
    id: "notes",
    left: "76%",
    top: "70%",
    title: "Plan notes",
    label: "Read notes",
    detail: "General notes and schedules can change the estimate. Keep this layer on top of the actual PDF.",
  },
];

export const BlueprintViewer: React.FC<BlueprintViewerProps> = ({
  currentRevision,
  projectName,
  previewUrl,
  isPreviewLoading = false,
  previewError = null,
}) => {
  const getFitZoom = () => {
    if (typeof window === "undefined") return 100;
    if (window.innerWidth < 640) return 50;
    if (window.innerWidth < 1024) return 75;
    return 100;
  };

  const [zoom, setZoom] = useState<number>(() => getFitZoom());
  const [activeHotspot, setActiveHotspot] = useState<string | null>("dimensions");
  const [showBeginnerLabels, setShowBeginnerLabels] = useState<boolean>(true);
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [startPan, setStartPan] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedHotspot = hotspots.find((hotspot) => hotspot.id === activeHotspot) ?? null;
  const hasPreview = Boolean(previewUrl);

  const handleZoomIn = () => setZoom((prev) => Math.min(prev + 25, 250));
  const handleZoomOut = () => setZoom((prev) => Math.max(prev - 25, 50));
  const handleFit = () => {
    setZoom(getFitZoom());
    setPanOffset({ x: 0, y: 0 });
  };
  const handleReset = () => {
    handleFit();
    setActiveHotspot("dimensions");
  };

  const handleMouseDown = (event: React.MouseEvent) => {
    if (!isPanning) return;
    setStartPan({ x: event.clientX - panOffset.x, y: event.clientY - panOffset.y });
  };

  const handleMouseMove = (event: React.MouseEvent) => {
    if (!isPanning || event.buttons !== 1) return;
    setPanOffset({ x: event.clientX - startPan.x, y: event.clientY - startPan.y });
  };

  const handleTouchStart = (event: React.TouchEvent) => {
    const touch = event.touches.length === 1 ? event.touches[0] : undefined;
    if (touch) setStartPan({ x: touch.clientX - panOffset.x, y: touch.clientY - panOffset.y });
  };

  const handleTouchMove = (event: React.TouchEvent) => {
    const touch = event.touches.length === 1 ? event.touches[0] : undefined;
    if (touch) setPanOffset({ x: touch.clientX - startPan.x, y: touch.clientY - startPan.y });
  };

  return (
    <div className="bg-white border border-[#e5e7eb] rounded-xl shadow-xs overflow-hidden flex flex-col h-[68dvh] min-h-[430px] sm:h-[500px] md:h-[580px]">
      <div className="min-h-11 bg-[#f9fafb] border-b border-[#e5e7eb] px-3 sm:px-4 py-2 flex flex-wrap items-center justify-between gap-2 select-none text-xs font-medium text-[#6b7280]">
        <div className="flex items-center gap-1.5 sm:gap-2.5 min-w-0">
          <div className="flex items-center gap-1.5 px-2 py-1 bg-white border border-[#e5e7eb] rounded-md text-[#111827] font-semibold shadow-2xs truncate max-w-[180px] sm:max-w-none">
            <FileText className="w-3.5 h-3.5 text-[#2563eb] shrink-0" />
            <span className="truncate">{currentRevision.fileName}</span>
          </div>
          <span className="px-1.5 sm:px-2 py-0.5 bg-[#eff6ff] text-[#2563eb] rounded text-[10px] font-bold border border-blue-200 shrink-0">
            Rev {currentRevision.revisionNumber}
          </span>
          <span className="text-[#6b7280] text-[11px] sm:text-xs hidden xs:inline shrink-0">{projectName}</span>
        </div>

        <div className="flex items-center gap-1 shrink-0 ml-auto">
          <button
            onClick={() => setIsPanning(!isPanning)}
            className={`p-1 sm:p-1.5 rounded-md transition ${
              isPanning ? "bg-[#2563eb] text-white" : "hover:bg-[#e5e7eb] text-[#4b5563]"
            }`}
            title={isPanning ? "Pan active" : "Move plan"}
          >
            <Hand className="w-3.5 h-3.5" />
          </button>
          <button onClick={handleZoomOut} className="p-1 sm:p-1.5 hover:bg-[#e5e7eb] text-[#4b5563] rounded-md transition" title="Zoom out">
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="w-8 sm:w-12 text-center text-xs font-semibold text-[#374151]">{zoom}%</span>
          <button onClick={handleZoomIn} className="p-1 sm:p-1.5 hover:bg-[#e5e7eb] text-[#4b5563] rounded-md transition" title="Zoom in">
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button onClick={handleFit} className="p-1 sm:p-1.5 hover:bg-[#e5e7eb] text-[#4b5563] rounded-md transition" title="Fit plan">
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          <button onClick={handleReset} className="p-1 sm:p-1.5 hover:bg-[#e5e7eb] text-[#4b5563] rounded-md transition" title="Reset view">
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        className={`flex-1 overflow-hidden relative bg-[#f3f4f6] flex items-center justify-center touch-none ${
          isPanning ? "cursor-grab active:cursor-grabbing" : "cursor-default"
        }`}
      >
        <div className="absolute top-3 left-3 right-3 z-30 flex flex-wrap items-start justify-between gap-2 pointer-events-none">
          <div className="pointer-events-auto bg-white/95 border border-[#dbeafe] rounded-lg shadow-xs p-2.5 max-w-[240px] sm:max-w-xs">
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-[#1d4ed8] uppercase tracking-wider">
              <MousePointer2 className="w-3.5 h-3.5" />
              Markup layer
            </div>
            <p className="hidden sm:block text-[11px] text-[#475569] mt-1">Blue marks and notes sit on top of the PDF you uploaded.</p>
          </div>
          <label className="pointer-events-auto flex items-center gap-2 bg-white/95 border border-[#e5e7eb] rounded-lg px-3 py-2 text-[11px] font-semibold text-[#374151] shadow-xs">
            <input
              type="checkbox"
              checked={showBeginnerLabels}
              onChange={(event) => setShowBeginnerLabels(event.target.checked)}
              className="accent-[#2563eb]"
            />
            Beginner labels
          </label>
        </div>

        <div
          style={{
            transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom / 100})`,
            transformOrigin: "center center",
            transition: isPanning ? "none" : "transform 0.15s ease-out",
          }}
          className="relative w-[min(920px,92%)] h-[min(1180px,92%)] min-h-[360px] bg-white border border-[#d1d5db] shadow-sm rounded-lg overflow-hidden select-none"
        >
          {hasPreview ? (
            <iframe
              key={previewUrl ?? currentRevision.id}
              src={`${previewUrl}#view=FitH&page=1&toolbar=0&navpanes=0`}
              title={`${currentRevision.fileName} PDF preview`}
              className="absolute inset-0 h-full w-full bg-white"
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center bg-white">
              <FileText className="w-10 h-10 text-[#94a3b8] mb-3" />
              <h3 className="text-sm font-bold text-[#111827]">
                {isPreviewLoading ? "Opening PDF preview" : "PDF preview unavailable"}
              </h3>
              <p className="text-xs text-[#64748b] max-w-sm mt-1">
                {previewError || "Upload a PDF through the workspace so RoughBid can show the real plan here."}
              </p>
            </div>
          )}

          <div className="absolute inset-0 z-20 pointer-events-none">
            {hotspots.map((hotspot) => (
              <button
                key={hotspot.id}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setActiveHotspot(hotspot.id);
                }}
                style={{ left: hotspot.left, top: hotspot.top }}
                className={`pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 z-10 w-7 h-7 rounded-full border-2 flex items-center justify-center shadow-sm transition ${
                  activeHotspot === hotspot.id
                    ? "bg-[#2563eb] border-white text-white scale-110"
                    : "bg-white border-[#2563eb] text-[#2563eb] hover:bg-[#eff6ff]"
                }`}
                title={hotspot.title}
                aria-label={`Explain ${hotspot.title}`}
              >
                <Info className="w-3.5 h-3.5" />
              </button>
            ))}

            {showBeginnerLabels &&
              hotspots.map((hotspot) => (
                <button
                  key={`${hotspot.id}-label`}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setActiveHotspot(hotspot.id);
                  }}
                  style={{ left: hotspot.left, top: `calc(${hotspot.top} + 22px)` }}
                  className="pointer-events-auto absolute -translate-x-1/2 z-10 px-2 py-1 bg-white/95 border border-[#bfdbfe] rounded text-[10px] font-bold text-[#1d4ed8] shadow-xs max-w-[120px] leading-tight"
                >
                  {hotspot.label}
                </button>
              ))}
          </div>

          {selectedHotspot && (
            <div className="absolute left-3 right-3 bottom-20 sm:left-auto sm:right-5 sm:top-20 sm:bottom-auto z-40 sm:w-64 bg-white border border-[#bfdbfe] rounded-lg shadow-lg p-3 text-left">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-bold text-[#2563eb]">Plan help</div>
                  <h4 className="text-sm font-black text-[#111827] mt-0.5">{selectedHotspot.title}</h4>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveHotspot(null)}
                  className="p-1 rounded hover:bg-[#f1f5f9] text-[#64748b]"
                  aria-label="Close plan help"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <p className="text-xs font-semibold text-[#1d4ed8] mt-2">{selectedHotspot.label}</p>
              <p className="text-xs text-[#475569] leading-relaxed mt-1.5">{selectedHotspot.detail}</p>
            </div>
          )}
        </div>

        <div className="absolute bottom-3 left-3 right-3 sm:right-auto z-30 bg-white/90 backdrop-blur-xs border border-[#e5e7eb] px-3 py-2 rounded-md text-xs text-[#4b5563] flex flex-col sm:flex-row sm:items-center gap-2 shadow-xs">
          <Info className="w-3.5 h-3.5 text-[#2563eb] hidden sm:block" />
          <span className="hidden sm:inline">Use zoom, hand and blue marks directly over the uploaded PDF.</span>
          <span className="sm:hidden font-semibold text-[#374151]">Zoom and drag the uploaded PDF</span>
          <input
            type="range"
            min={50}
            max={250}
            step={25}
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
            className="w-full sm:w-36 accent-[#2563eb]"
            aria-label="Plan zoom"
          />
        </div>
      </div>
    </div>
  );
};
