import React, { useEffect, useMemo, useState } from "react";
import { CheckCircle2, FileText, PenLine, ShieldCheck } from "lucide-react";
import { getClientProposal, signClientProposal, type PublicClientProposal } from "../services/api";
import { formatCurrency } from "../utils/calculations";

interface ClientProposalPageProps {
  token: string;
}

export const ClientProposalPage: React.FC<ClientProposalPageProps> = ({ token }) => {
  const [proposal, setProposal] = useState<PublicClientProposal | null>(null);
  const [signerName, setSignerName] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "signing" | "signed" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setState("loading");
    getClientProposal(token)
      .then((next) => {
        if (!active) return;
        setProposal(next);
        setSignerName(next.signature_name ?? next.client_name ?? "");
        setState(next.status === "signed" ? "signed" : "ready");
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Proposal not found.");
        setState("error");
      });
    return () => {
      active = false;
    };
  }, [token]);

  const expiresLabel = useMemo(() => {
    if (!proposal) return "";
    return new Date(proposal.expires_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }, [proposal]);

  const handleSign = async (event: React.FormEvent) => {
    event.preventDefault();
    setState("signing");
    setError(null);
    try {
      const signed = await signClientProposal(token, signerName);
      setProposal((current) => current ? {
        ...current,
        status: "signed",
        signed_at: signed.signed_at,
        signature_name: signed.signature_name,
      } : current);
      setState("signed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign this proposal.");
      setState("ready");
    }
  };

  if (state === "loading") {
    return <div className="min-h-screen bg-[#f8fafc] flex items-center justify-center text-sm text-[#475569]">Loading proposal...</div>;
  }

  if (state === "error" || !proposal) {
    return (
      <div className="min-h-screen bg-[#f8fafc] flex items-center justify-center p-6">
        <div className="max-w-md bg-white border border-[#e5e7eb] rounded-lg p-6 text-center shadow-xs">
          <FileText className="w-8 h-8 mx-auto text-[#94a3b8]" />
          <h1 className="text-lg font-bold text-[#111827] mt-3">Proposal unavailable</h1>
          <p className="text-sm text-[#64748b] mt-1">{error ?? "This link is expired, revoked, or invalid."}</p>
        </div>
      </div>
    );
  }

  const payload = proposal.public_payload;

  return (
    <div className="min-h-screen bg-[#f8fafc] text-[#111827]">
      <header className="bg-white border-b border-[#e5e7eb] px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-3">
          <img src="/favicon.svg" alt="RoughBid" className="w-9 h-9 object-contain" />
          <div className="text-right">
            <div className="text-[10px] font-bold uppercase tracking-wider text-[#64748b]">Client Proposal</div>
            <div className="text-xs text-[#2563eb] font-semibold">Secure RoughBid view</div>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto p-4 sm:p-6 space-y-5">
        <section className="bg-white border border-[#e5e7eb] rounded-lg p-5 sm:p-7 shadow-xs">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 border-b border-[#e5e7eb] pb-5">
            <div>
              <h1 className="text-2xl font-black tracking-tight">{proposal.title}</h1>
              <p className="text-sm text-[#64748b] mt-1">{payload.projectAddress}</p>
              <p className="text-xs text-[#64748b] mt-1">Prepared for {proposal.client_name}</p>
            </div>
            <div className="sm:text-right">
              <div className="text-[10px] font-bold uppercase tracking-wider text-[#64748b]">Total Proposal</div>
              <div className="text-3xl font-black text-[#2563eb] font-mono">{formatCurrency(Number(proposal.total_amount))}</div>
              <div className="text-xs text-[#64748b] mt-1">Valid through {expiresLabel}</div>
            </div>
          </div>

          <div className="mt-6 overflow-x-auto">
            <table className="w-full text-sm min-w-[520px]">
              <thead className="text-[10px] uppercase tracking-wider text-[#64748b] border-b border-[#e5e7eb]">
                <tr>
                  <th className="text-left py-2">Scope</th>
                  <th className="text-right py-2">Qty</th>
                  <th className="text-right py-2">Price</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f1f5f9]">
                {payload.lineItems.map((item, index) => (
                  <tr key={`${item.name}-${index}`}>
                    <td className="py-3 font-semibold">{item.name}</td>
                    <td className="py-3 text-right text-[#64748b]">{item.quantity.toLocaleString()} {item.unit}</td>
                    <td className="py-3 text-right font-bold">{formatCurrency(item.price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-6 bg-[#f8fafc] border border-[#e5e7eb] rounded-lg p-4">
            <div className="flex items-center gap-2 text-sm font-bold">
              <ShieldCheck className="w-4 h-4 text-[#2563eb]" />
              Terms
            </div>
            <ul className="mt-2 space-y-1 text-xs text-[#475569]">
              {payload.terms.map((term) => <li key={term}>{term}</li>)}
            </ul>
          </div>
        </section>

        <section className="bg-white border border-[#e5e7eb] rounded-lg p-5 sm:p-6 shadow-xs">
          {proposal.status === "signed" || state === "signed" ? (
            <div className="flex items-start gap-3 text-emerald-800">
              <CheckCircle2 className="w-5 h-5 mt-0.5" />
              <div>
                <h2 className="text-sm font-bold">Accepted and signed</h2>
                <p className="text-xs mt-1">Signed by {proposal.signature_name} on {proposal.signed_at ? new Date(proposal.signed_at).toLocaleString() : "today"}.</p>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSign} className="space-y-3">
              <div className="flex items-center gap-2">
                <PenLine className="w-4 h-4 text-[#2563eb]" />
                <h2 className="text-sm font-bold">Accept proposal</h2>
              </div>
              <label className="block">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#64748b]">Signature name</span>
                <input
                  value={signerName}
                  onChange={(event) => setSignerName(event.target.value)}
                  required
                  maxLength={160}
                  className="mt-1 w-full border border-[#cbd5e1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#2563eb]"
                />
              </label>
              {error && <p className="text-xs text-red-600">{error}</p>}
              <button
                type="submit"
                disabled={state === "signing"}
                className="w-full sm:w-auto px-4 py-2 rounded-md bg-[#2563eb] text-white text-sm font-bold disabled:opacity-60"
              >
                {state === "signing" ? "Signing..." : "Sign and accept"}
              </button>
            </form>
          )}
        </section>
      </main>
    </div>
  );
};
