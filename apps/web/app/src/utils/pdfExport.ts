import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type { Project } from "../types/index.ts";
import { calculateProjectFinancials, formatCurrency, formatPercentage } from "./calculations.ts";

const PAGE_MARGIN = 40;
const BOTTOM_SPACE = 60;

function lastTableY(doc: jsPDF): number {
  return (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
}

/** Keep the complete totals/acceptance block together inside the printable area. */
function reserveBlock(doc: jsPDF, y: number, height: number): number {
  if (y + height <= doc.internal.pageSize.getHeight() - BOTTOM_SPACE) return y;
  doc.addPage();
  return PAGE_MARGIN;
}

/** AutoTable wraps long names, addresses and filenames and paginates if needed. */
function projectDetails(doc: jsPDF, project: Project, startY: number): number {
  const revision = project.revisions.find((item) => item.isCurrent) ?? project.revisions[0];
  autoTable(doc, {
    startY,
    body: [
      [{ content: project.name, styles: { fontStyle: "bold", fontSize: 12, textColor: [15, 23, 42] } }],
      [`Client: ${project.clientName}`],
      [`Address: ${project.address}`],
      [`Plan: ${revision?.fileName || "No plan uploaded"}${revision ? ` (Rev ${revision.revisionNumber})` : ""}`],
      [`Date: ${new Date().toLocaleDateString()}`],
    ],
    theme: "plain",
    styles: { fontSize: 9, textColor: [71, 85, 105], fillColor: [248, 250, 252], overflow: "linebreak", cellPadding: { top: 5, bottom: 5, left: 15, right: 15 } },
    tableWidth: doc.internal.pageSize.getWidth() - PAGE_MARGIN * 2,
    margin: { top: PAGE_MARGIN, bottom: BOTTOM_SPACE, left: PAGE_MARGIN, right: PAGE_MARGIN },
  });
  return lastTableY(doc) + 15;
}

export function buildInternalEstimatePDF(project: Project): jsPDF {
  const doc = new jsPDF({
    orientation: "portrait",
    unit: "pt",
    format: "letter",
  });

  const financials = calculateProjectFinancials(
    project.estimateItems,
    project.overheadPercentage,
    project.markupPercentage
  );

  // Header Banner
  doc.setFillColor(30, 58, 138); // Dark Navy Blue
  doc.rect(0, 0, 612, 60, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.setTextColor(255, 255, 255);
  doc.text("ROUGHbid", 40, 36);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(200, 220, 255);
  doc.text("CONSTRUCTION ESTIMATING & TAKEOFF", 160, 35);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(255, 255, 255);
  doc.text("INTERNAL ESTIMATE BREAKDOWN", 400, 35);

  const tableStartY = projectDetails(doc, project, 75);

  // Table of Items
  const tableData = project.estimateItems.map((item, idx) => [
    idx + 1,
    item.name,
    `${item.quantity.toLocaleString()} ${item.unit}`,
    formatCurrency(item.materialCost),
    formatCurrency(item.laborCost),
    formatCurrency(item.equipmentCost),
    formatCurrency(item.directCost),
  ]);

  autoTable(doc, {
    startY: tableStartY,
    head: [["#", "Item Description", "Takeoff Qty", "Material", "Labor", "Equip/Other", "Direct Cost"]],
    body: tableData,
    theme: "grid",
    headStyles: {
      fillColor: [37, 99, 235], // Accent Blue
      textColor: 255,
      fontSize: 8,
      fontStyle: "bold",
    },
    bodyStyles: {
      fontSize: 8,
      textColor: [30, 41, 59],
    },
    columnStyles: {
      0: { cellWidth: 20, halign: "center" },
      1: { cellWidth: 210 },
      2: { cellWidth: 65, halign: "right" },
      3: { cellWidth: 55, halign: "right" },
      4: { cellWidth: 55, halign: "right" },
      5: { cellWidth: 55, halign: "right" },
      6: { cellWidth: 72, halign: "right", fontStyle: "bold" },
    },
    margin: { top: PAGE_MARGIN, bottom: BOTTOM_SPACE, left: PAGE_MARGIN, right: PAGE_MARGIN },
  });

  // Financial Summary Block
  const finalY = reserveBlock(doc, lastTableY(doc) + 20, 150);

  doc.setFillColor(248, 250, 252);
  doc.roundedRect(300, finalY, 272, 140, 4, 4, "F");
  doc.setDrawColor(203, 213, 225);
  doc.roundedRect(300, finalY, 272, 140, 4, 4, "D");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(30, 41, 59);
  doc.text("Financial Engine Recap", 315, finalY + 18);

  const startSumY = finalY + 36;
  const lineSpacing = 16;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(71, 85, 105);

  doc.text("Total Direct Cost:", 315, startSumY);
  doc.text(formatCurrency(financials.directCost), 555, startSumY, { align: "right" });

  doc.text(`Overhead (${financials.overheadPercentage}%):`, 315, startSumY + lineSpacing);
  doc.text(formatCurrency(financials.overheadAmount), 555, startSumY + lineSpacing, { align: "right" });

  doc.text("Cost Before Markup:", 315, startSumY + lineSpacing * 2);
  doc.text(formatCurrency(financials.costBeforeMarkup), 555, startSumY + lineSpacing * 2, { align: "right" });

  doc.text(`Markup (${financials.markupPercentage}%):`, 315, startSumY + lineSpacing * 3);
  doc.text(formatCurrency(financials.markupAmount), 555, startSumY + lineSpacing * 3, { align: "right" });

  // Divider
  doc.setDrawColor(203, 213, 225);
  doc.line(315, startSumY + lineSpacing * 3.8, 555, startSumY + lineSpacing * 3.8);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(29, 78, 216); // Blue
  doc.text("Final Estimate Price:", 315, startSumY + lineSpacing * 4.9);
  doc.text(formatCurrency(financials.finalPrice), 555, startSumY + lineSpacing * 4.9, { align: "right" });

  doc.setFontSize(8.5);
  doc.setTextColor(16, 185, 129); // Green
  doc.text(`Estimated Gross Margin: ${formatPercentage(financials.marginPercentage)}`, 315, startSumY + lineSpacing * 5.9);

  // Footer
  for (let page = 1; page <= doc.getNumberOfPages(); page++) {
    doc.setPage(page);
    doc.setFont("helvetica", "italic");
    doc.setFontSize(7.5);
    doc.setTextColor(148, 163, 184);
    doc.text("Confidential Internal Document — Generated by ROUGHbid (KSP Ventures)", 40, 750);
  }

  return doc;
}

export function exportInternalEstimatePDF(project: Project): void {
  const doc = buildInternalEstimatePDF(project);
  const sanitizedName = project.name.replace(/[^a-zA-Z0-9_-]/g, "_");
  doc.save(`ROUGHbid_Internal_Estimate_${sanitizedName}.pdf`);
}

export function buildClientProposalPDF(project: Project): jsPDF {
  const doc = new jsPDF({
    orientation: "portrait",
    unit: "pt",
    format: "letter",
  });

  const financials = calculateProjectFinancials(
    project.estimateItems,
    project.overheadPercentage,
    project.markupPercentage
  );

  // Cover / Header Banner
  doc.setFillColor(30, 58, 138); // Dark Navy Blue
  doc.rect(0, 0, 612, 110, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.setTextColor(255, 255, 255);
  doc.text("CONSTRUCTION PROPOSAL", 40, 48);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(203, 213, 225);
  doc.text("PREPARED FOR CLIENT REVIEW", 40, 68);
  doc.text(`Proposal Date: ${new Date().toLocaleDateString()}`, 40, 84);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(255, 255, 255);
  doc.text("ROUGHbid", 550, 48, { align: "right" });
  doc.setFontSize(8);
  doc.setTextColor(191, 219, 254);
  doc.text("Contractor & Estimating Services", 550, 66, { align: "right" });

  const tableStartY = projectDetails(doc, project, 130);

  // Client-Friendly Scope of Work (NO internal markup, overhead, or material/labor cost splits!)
  const clientTableRows = project.estimateItems.map((item, idx) => {
    // Proportional client line total:
    const itemWeight = financials.directCost > 0 ? item.directCost / financials.directCost : 0;
    const clientLinePrice = financials.finalPrice * itemWeight;

    return [
      idx + 1,
      item.name,
      `${item.quantity.toLocaleString()} ${item.unit}`,
      "Furnish, Deliver & Complete Turnkey Installation per Plan",
      formatCurrency(clientLinePrice),
    ];
  });

  autoTable(doc, {
    startY: tableStartY,
    head: [["#", "Scope Description", "Quantity", "Inclusions / Trade Scope", "Item Price"]],
    body: clientTableRows,
    theme: "striped",
    headStyles: {
      fillColor: [30, 58, 138],
      textColor: 255,
      fontSize: 9,
      fontStyle: "bold",
    },
    bodyStyles: {
      fontSize: 8.5,
      textColor: [30, 41, 59],
    },
    columnStyles: {
      0: { cellWidth: 25, halign: "center" },
      1: { cellWidth: 160, fontStyle: "bold" },
      2: { cellWidth: 65, halign: "center" },
      3: { cellWidth: 200 },
      4: { cellWidth: 82, halign: "right", fontStyle: "bold" },
    },
    margin: { top: PAGE_MARGIN, bottom: BOTTOM_SPACE, left: PAGE_MARGIN, right: PAGE_MARGIN },
  });

  // Client Total Block
  const finalY = reserveBlock(doc, lastTableY(doc) + 20, 200);

  doc.setFillColor(239, 246, 255);
  doc.roundedRect(300, finalY, 272, 60, 4, 4, "F");
  doc.setDrawColor(191, 219, 254);
  doc.roundedRect(300, finalY, 272, 60, 4, 4, "D");

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(30, 58, 138);
  doc.text("Total Proposed Investment:", 315, finalY + 22);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(29, 78, 216);
  doc.text(formatCurrency(financials.finalPrice), 555, finalY + 45, { align: "right" });

  // Terms & Acceptance
  const termsY = finalY + 80;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(15, 23, 42);
  doc.text("Terms of Proposal & Acceptance", 40, termsY);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text("1. All work to be completed in a workmanlike manner according to standard practices.", 40, termsY + 16);
  doc.text("2. Any alteration or deviation from plan specifications involving extra costs will be executed upon written change orders.", 40, termsY + 28);
  doc.text("3. Proposal is valid for 30 calendar days from the date of issuance.", 40, termsY + 40);

  // Signatures
  doc.setDrawColor(203, 213, 225);
  doc.line(40, termsY + 85, 250, termsY + 85);
  doc.line(320, termsY + 85, 530, termsY + 85);

  doc.setFontSize(8);
  doc.text("Authorized Contractor Signature", 40, termsY + 98);
  doc.text("Client Acceptance Signature & Date", 320, termsY + 98);

  return doc;
}

export function exportClientProposalPDF(project: Project): void {
  const doc = buildClientProposalPDF(project);
  const sanitizedName = project.name.replace(/[^a-zA-Z0-9_-]/g, "_");
  doc.save(`ROUGHbid_Client_Proposal_${sanitizedName}.pdf`);
}
