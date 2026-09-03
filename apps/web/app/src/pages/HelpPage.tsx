import React from "react";
import { HelpCircle, BookOpen, Calculator, ShieldCheck, Mail } from "lucide-react";

export const HelpPage: React.FC = () => {
  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6 select-none font-sans">
      <div>
        <h1 className="text-[22px] font-extrabold text-slate-900 tracking-tight">
          Help & Estimating Documentation
        </h1>
        <p className="text-[13px] text-slate-500 mt-0.5">
          Everything you need to master takeoff workflows and ROUGHbid calculations.
        </p>
      </div>

      <div className="space-y-4">
        {/* Core Mathematical Formulas Guide */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-4">
          <h2 className="text-[15px] font-bold text-slate-900 flex items-center gap-2">
            <Calculator className="w-4 h-4 text-blue-600" />
            <span>Deterministic Financial Engine Reference</span>
          </h2>

          <p className="text-[13px] text-slate-600 leading-relaxed">
            ROUGHbid strictly adheres to the standard prime contractor formulas. The calculation engine is fully deterministic and authoritative:
          </p>

          <div className="p-4 bg-slate-50 rounded-lg space-y-2 text-[12.5px] font-mono text-slate-800 border border-slate-200">
            <div><strong>1. Direct Cost</strong> = Sum(Material + Labor + Equipment)</div>
            <div><strong>2. Overhead Amount</strong> = Direct Cost × (Overhead % / 100)</div>
            <div><strong>3. Cost Before Markup</strong> = Direct Cost + Overhead Amount</div>
            <div><strong>4. Markup Amount</strong> = Cost Before Markup × (Markup % / 100)</div>
            <div><strong>5. Final Price</strong> = Cost Before Markup + Markup Amount</div>
            <div><strong>6. Gross Margin %</strong> = (Markup Amount / Final Price) × 100</div>
          </div>
        </div>

        {/* Prime Bid Class Pass Info */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-3">
          <h2 className="text-[15px] font-bold text-slate-900 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-600" />
            <span>About KSP Ventures & Prime Bid</span>
          </h2>
          <p className="text-[13px] text-slate-600 leading-relaxed">
            ROUGHbid is built by KSP Ventures as an accessible, high-speed construction takeoff and rough estimating utility connected directly to the Prime Bid master estimating platform.
          </p>
        </div>

        {/* Support */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs flex items-center justify-between">
          <div>
            <h3 className="text-[14px] font-bold text-slate-900">Need Estimating Support?</h3>
            <p className="text-[12px] text-slate-500">Contact the KSP Estimating engineering group.</p>
          </div>
          <button
            onClick={() => alert("Support ticket opened with KSP Ventures Estimating Group.")}
            className="flex items-center gap-1.5 px-4 py-2 bg-slate-900 text-white rounded-md text-[13px] font-semibold hover:bg-slate-800 transition"
          >
            <Mail className="w-4 h-4" />
            <span>Contact Support</span>
          </button>
        </div>
      </div>
    </div>
  );
};
