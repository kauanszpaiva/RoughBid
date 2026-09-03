import React, { useState, useRef } from "react";
import {
  ZoomIn,
  ZoomOut,
  Hand,
  RotateCcw,
  FileText,
  Info,
} from "lucide-react";
import { PlanRevision } from "../types";

interface BlueprintViewerProps {
  currentRevision: PlanRevision;
  projectName: string;
}

export const BlueprintViewer: React.FC<BlueprintViewerProps> = ({
  currentRevision,
  projectName,
}) => {
  const [zoom, setZoom] = useState<number>(100);
  const [activeLayer, setActiveLayer] = useState<"all" | "structural" | "finishes">("all");
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [startPan, setStartPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [currentPage] = useState<number>(1);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleZoomIn = () => setZoom((prev) => Math.min(prev + 25, 250));
  const handleZoomOut = () => setZoom((prev) => Math.max(prev - 25, 50));
  const handleReset = () => {
    setZoom(100);
    setPanOffset({ x: 0, y: 0 });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isPanning) return;
    setStartPan({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isPanning || e.buttons !== 1) return;
    setPanOffset({
      x: e.clientX - startPan.x,
      y: e.clientY - startPan.y,
    });
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches.length === 1 ? e.touches[0] : undefined;
    if (touch) {
      setStartPan({ x: touch.clientX - panOffset.x, y: touch.clientY - panOffset.y });
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const touch = e.touches.length === 1 ? e.touches[0] : undefined;
    if (touch) {
      setPanOffset({
        x: touch.clientX - startPan.x,
        y: touch.clientY - startPan.y,
      });
    }
  };

  return (
    <div className="bg-white border border-[#e5e7eb] rounded-xl shadow-xs overflow-hidden flex flex-col h-[440px] sm:h-[500px] md:h-[580px]">
      {/* Top Toolbar */}
      <div className="min-h-11 bg-[#f9fafb] border-b border-[#e5e7eb] px-3 sm:px-4 py-2 flex flex-wrap items-center justify-between gap-2 select-none text-xs font-medium text-[#6b7280]">
        <div className="flex items-center gap-1.5 sm:gap-2.5 min-w-0">
          <div className="flex items-center gap-1.5 px-2 py-1 bg-white border border-[#e5e7eb] rounded-md text-[#111827] font-semibold shadow-2xs truncate max-w-[140px] sm:max-w-none">
            <FileText className="w-3.5 h-3.5 text-[#2563eb] shrink-0" />
            <span className="truncate">{currentRevision.fileName}</span>
          </div>
          <span className="px-1.5 sm:px-2 py-0.5 bg-[#eff6ff] text-[#2563eb] rounded text-[10px] font-bold border border-blue-200 shrink-0">
            Rev {currentRevision.revisionNumber}
          </span>
          <span className="text-[#6b7280] text-[11px] sm:text-xs hidden xs:inline shrink-0">
            Page {currentPage} of {currentRevision.pages}
          </span>
        </div>

        {/* View Controls */}
        <div className="flex items-center gap-1 shrink-0 ml-auto">
          {/* Layer toggles */}
          <div className="flex items-center bg-[#e5e7eb] p-0.5 rounded-lg text-xs mr-1 sm:mr-2">
            <button
              onClick={() => setActiveLayer("all")}
              className={`px-2 sm:px-2.5 py-0.5 sm:py-1 rounded-md transition text-xs ${
                activeLayer === "all" ? "bg-white text-[#111827] font-semibold shadow-xs" : "text-[#4b5563] hover:text-[#111827]"
              }`}
            >
              All
            </button>
            <button
              onClick={() => setActiveLayer("structural")}
              className={`px-2 sm:px-2.5 py-0.5 sm:py-1 rounded-md transition text-xs ${
                activeLayer === "structural" ? "bg-white text-[#111827] font-semibold shadow-xs" : "text-[#4b5563] hover:text-[#111827]"
              }`}
            >
              Framing
            </button>
            <button
              onClick={() => setActiveLayer("finishes")}
              className={`px-2 sm:px-2.5 py-0.5 sm:py-1 rounded-md transition text-xs ${
                activeLayer === "finishes" ? "bg-white text-[#111827] font-semibold shadow-xs" : "text-[#4b5563] hover:text-[#111827]"
              }`}
            >
              Finishes
            </button>
          </div>

          <button
            onClick={() => setIsPanning(!isPanning)}
            className={`p-1 sm:p-1.5 rounded-md transition ${
              isPanning ? "bg-[#2563eb] text-white" : "hover:bg-[#e5e7eb] text-[#4b5563]"
            }`}
            title={isPanning ? "Pan active (drag canvas)" : "Enable pan tool"}
          >
            <Hand className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={handleZoomOut}
            className="p-1 sm:p-1.5 hover:bg-[#e5e7eb] text-[#4b5563] rounded-md transition"
            title="Zoom Out"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>

          <span className="w-8 sm:w-12 text-center text-xs font-semibold text-[#374151]">
            {zoom}%
          </span>

          <button
            onClick={handleZoomIn}
            className="p-1 sm:p-1.5 hover:bg-[#e5e7eb] text-[#4b5563] rounded-md transition"
            title="Zoom In"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={handleReset}
            className="p-1 sm:p-1.5 hover:bg-[#e5e7eb] text-[#4b5563] rounded-md transition"
            title="Reset Zoom"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Blueprint Canvas Container */}
      <div
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        className={`flex-1 overflow-hidden relative bg-[#f9fafb] flex items-center justify-center touch-none ${
          isPanning ? "cursor-grab active:cursor-grabbing" : "cursor-default"
        }`}
      >
        <div
          style={{
            transform: `scale(${zoom / 100}) translate(${panOffset.x}px, ${panOffset.y}px)`,
            transformOrigin: "center center",
            transition: isPanning ? "none" : "transform 0.15s ease-out",
          }}
          className="w-[720px] h-[480px] bg-white border border-[#d1d5db] shadow-sm p-6 relative select-none rounded-lg"
        >
          {/* Grid Background */}
          <div
            className="absolute inset-0 opacity-[0.05] pointer-events-none"
            style={{
              backgroundImage:
                "linear-gradient(#000 1px, transparent 1px), linear-gradient(90deg, #000 1px, transparent 1px)",
              backgroundSize: "20px 20px",
            }}
          />

          {/* Architectural Drawing Area */}
          <div className="w-full h-full border border-[#9ca3af] relative p-4 flex flex-col justify-between rounded-xs">
            {/* Top Drawing Title */}
            <div className="flex items-center justify-between border-b border-[#e5e7eb] pb-2">
              <div>
                <div className="text-xs font-bold text-[#111827] tracking-wide">
                  PLAN SHEET A-1: DECK FRAMING & TAKEOFF LAYOUT
                </div>
                <div className="text-[10px] text-[#6b7280] font-mono">
                  SCALE: 1/4&quot; = 1&apos;-0&quot; | REVISION: {currentRevision.revisionNumber}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs font-semibold text-[#111827]">
                  {projectName}
                </div>
                <div className="text-[10px] text-[#6b7280]">
                  ARCHITECTURAL SET — KSP VENTURES
                </div>
              </div>
            </div>

            {/* Main Architectural Floor Plan Drawing */}
            <div className="flex-1 my-3 relative flex items-center justify-center">
              <svg
                viewBox="0 0 600 300"
                className="w-full h-full max-h-[280px]"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                {/* Existing House Wall (top) */}
                <rect x="120" y="20" width="360" height="24" fill="#e5e7eb" stroke="#374151" strokeWidth="2" />
                <text x="300" y="36" textAnchor="middle" fill="#4b5563" fontSize="10" fontWeight="bold" fontFamily="sans-serif">
                  EXISTING HOUSE / LEDGER ATTACHMENT
                </text>

                {/* Deck Outer Perimeter */}
                <rect x="150" y="44" width="300" height="190" fill="#ffffff" stroke="#1f2937" strokeWidth="2.5" />

                {/* Joist Lines (Structural layer) */}
                {(activeLayer === "all" || activeLayer === "structural") && (
                  <g stroke="#9ca3af" strokeWidth="1" strokeDasharray="4,2">
                    {[170, 190, 210, 230, 250, 270, 290, 310, 330, 350, 370, 390, 410, 430].map((x) => (
                      <line key={x} x1={x} y1="44" x2={x} y2="234" />
                    ))}
                  </g>
                )}

                {/* Decking Planks (Finishes layer) */}
                {(activeLayer === "all" || activeLayer === "finishes") && (
                  <g stroke="#d1d5db" strokeWidth="1">
                    {[60, 75, 90, 105, 120, 135, 150, 165, 180, 195, 210, 225].map((y) => (
                      <line key={y} x1="150" y1={y} x2="450" y2={y} />
                    ))}
                  </g>
                )}

                {/* Concrete Post Footings */}
                {[
                  { cx: 170, cy: 220 },
                  { cx: 300, cy: 220 },
                  { cx: 430, cy: 220 },
                  { cx: 170, cy: 130 },
                  { cx: 430, cy: 130 },
                ].map((pt, i) => (
                  <g key={i}>
                    <circle cx={pt.cx} cy={pt.cy} r="8" fill="#e5e7eb" stroke="#111827" strokeWidth="1.5" />
                    <rect x={pt.cx - 4} y={pt.cy - 4} width="8" height="8" fill="#2563eb" />
                  </g>
                ))}

                {/* Stairs off deck */}
                <rect x="250" y="234" width="100" height="40" fill="#f9fafb" stroke="#374151" strokeWidth="1.5" />
                <line x1="250" y1="247" x2="350" y2="247" stroke="#6b7280" strokeWidth="1" />
                <line x1="250" y1="260" x2="350" y2="260" stroke="#6b7280" strokeWidth="1" />
                <line x1="250" y1="273" x2="350" y2="273" stroke="#6b7280" strokeWidth="1" />
                <text x="300" y="258" textAnchor="middle" fill="#4b5563" fontSize="8" fontWeight="bold">
                  STAIRS (4 RISERS)
                </text>

                {/* Dimension callouts */}
                {/* Horizontal dimension (Top) */}
                <line x1="150" y1="12" x2="450" y2="12" stroke="#2563eb" strokeWidth="1.2" />
                <line x1="150" y1="8" x2="150" y2="16" stroke="#2563eb" strokeWidth="1.2" />
                <line x1="450" y1="8" x2="450" y2="16" stroke="#2563eb" strokeWidth="1.2" />
                <text x="300" y="10" textAnchor="middle" fill="#2563eb" fontSize="9" fontWeight="bold" fontFamily="monospace">
                  20&apos; - 0&quot;
                </text>

                {/* Vertical dimension (Left) */}
                <line x1="130" y1="44" x2="130" y2="234" stroke="#2563eb" strokeWidth="1.2" />
                <line x1="126" y1="44" x2="134" y2="44" stroke="#2563eb" strokeWidth="1.2" />
                <line x1="126" y1="234" x2="134" y2="234" stroke="#2563eb" strokeWidth="1.2" />
                <text x="122" y="142" textAnchor="end" fill="#2563eb" fontSize="9" fontWeight="bold" fontFamily="monospace">
                  14&apos; - 0&quot;
                </text>

                {/* Callout tags */}
                <rect x="360" y="80" width="80" height="20" rx="4" fill="#eff6ff" stroke="#2563eb" strokeWidth="1" />
                <text x="400" y="93" textAnchor="middle" fill="#1d4ed8" fontSize="8" fontWeight="bold">
                  280 SF DECKING
                </text>

                {/* North Indicator */}
                <g transform="translate(540, 60)">
                  <circle cx="0" cy="0" r="16" fill="white" stroke="#6b7280" strokeWidth="1" />
                  <path d="M 0,-12 L 5,4 L 0,0 L -5,4 Z" fill="#111827" />
                  <text x="0" y="-14" textAnchor="middle" fill="#111827" fontSize="8" fontWeight="bold">
                    N
                  </text>
                </g>
              </svg>
            </div>

            {/* Bottom Title Block */}
            <div className="border-t border-[#e5e7eb] pt-2 flex items-center justify-between text-[10px] text-[#6b7280] font-mono">
              <div className="flex items-center gap-4">
                <span>PROJECT ID: ROUGH-88D8</span>
                <span>DRAWN BY: KSP ARCHITECTS</span>
                <span>DISCIPLINE: STRUCTURAL / ARCH</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-[#374151]">STATUS: APPROVED FOR TAKEOFF</span>
                <div className="w-2 h-2 rounded-full bg-emerald-500" />
              </div>
            </div>
          </div>
        </div>

        {/* Floating helper badge */}
        <div className="absolute bottom-3 left-3 bg-white/90 backdrop-blur-xs border border-[#e5e7eb] px-3 py-1 rounded-md text-xs text-[#4b5563] flex items-center gap-1.5 shadow-xs">
          <Info className="w-3.5 h-3.5 text-[#2563eb]" />
          <span>Interactive Architectural Blueprint Viewer — {currentRevision.fileName}</span>
        </div>
      </div>
    </div>
  );
};
