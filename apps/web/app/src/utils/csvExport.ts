import { Project } from "../types";
import { calculateProjectFinancials } from "./calculations";

export function exportInternalEstimateCSV(project: Project): void {
  const financials = calculateProjectFinancials(
    project.estimateItems,
    project.overheadPercentage,
    project.markupPercentage
  );

  const currentRevision = project.revisions.find((r) => r.isCurrent) || project.revisions[0];

  const headers = [
    "Item #",
    "CSI Code",
    "Description",
    "Quantity",
    "Unit",
    "Material Cost ($)",
    "Labor Cost ($)",
    "Equipment Cost ($)",
    "Direct Cost ($)",
  ];

  const rows = project.estimateItems.map((item, index) => [
    index + 1,
    item.csiCode || "N/A",
    `"${item.name.replace(/"/g, '""')}"`,
    item.quantity,
    item.unit,
    item.materialCost.toFixed(2),
    item.laborCost.toFixed(2),
    item.equipmentCost.toFixed(2),
    item.directCost.toFixed(2),
  ]);

  // Project Header and Financial Engine Summary rows
  const metaRows = [
    ["ROUGHbid Construction Estimating - Internal Cost Breakdown"],
    ["Project Name", `"${project.name.replace(/"/g, '""')}"`],
    ["Client", `"${project.clientName.replace(/"/g, '""')}"`],
    ["Address", `"${project.address.replace(/"/g, '""')}"`],
    ["Plan Revision", `Rev ${currentRevision?.revisionNumber || "01"} (${currentRevision?.fileName || "None"})`],
    ["Date Generated", new Date().toLocaleDateString()],
    [],
  ];

  const summaryRows = [
    [],
    ["--- FINANCIAL SUMMARY ---"],
    ["Total Direct Cost", "", "", "", "", "", "", "", financials.directCost.toFixed(2)],
    [`Overhead (${financials.overheadPercentage}%)`, "", "", "", "", "", "", "", financials.overheadAmount.toFixed(2)],
    ["Cost Before Markup", "", "", "", "", "", "", "", financials.costBeforeMarkup.toFixed(2)],
    [`Markup (${financials.markupPercentage}%)`, "", "", "", "", "", "", "", financials.markupAmount.toFixed(2)],
    ["FINAL ESTIMATE PRICE", "", "", "", "", "", "", "", financials.finalPrice.toFixed(2)],
    [`Estimated Gross Margin`, "", "", "", "", "", "", "", `${financials.marginPercentage.toFixed(2)}%`],
  ];

  const csvContent = [
    ...metaRows.map((r) => r.join(",")),
    headers.join(","),
    ...rows.map((r) => r.join(",")),
    ...summaryRows.map((r) => r.join(",")),
  ].join("\r\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const sanitizedName = project.name.replace(/[^a-zA-Z0-9_-]/g, "_");
  link.setAttribute("href", url);
  link.setAttribute("download", `ROUGHbid_Internal_Estimate_${sanitizedName}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export const exportProjectCSV = exportInternalEstimateCSV;

export function exportPrimeBidJSON(project: Project): void {
  const financials = calculateProjectFinancials(
    project.estimateItems,
    project.overheadPercentage,
    project.markupPercentage
  );

  const payload = {
    platform: "ROUGHbid",
    targetSystem: "Prime Bid Estimating Suite",
    version: "2026.3",
    exportedAt: new Date().toISOString(),
    project: {
      ...project,
      financials,
    },
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const sanitizedName = project.name.replace(/[^a-zA-Z0-9_-]/g, "_");
  link.setAttribute("href", url);
  link.setAttribute("download", `PrimeBid_Package_${sanitizedName}.json`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

