export type ArchitecturalLength = {
  feet: number;
  inches: number;
  totalFeet: number;
};

export type ParsedArchitecturalScale = {
  paperInches: number;
  realFeet: number;
  drawingFeetPerPdfPoint: number;
};

export type ArchitecturalScaleEvidence = {
  sourceType: 'printed_scale' | 'explicit_dimension';
  drawingUnits: number;
  pdfPoints: number;
  sourceExcerpt: string;
};

const normalizeMarks = (value: string) => value
  .replace(/[′’‘`]/g, "'")
  .replace(/[″“”]/g, '"')
  .replace(/\u00a0/g, ' ')
  .trim();

function parseUnsignedMagnitude(value: string): number | null {
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text || text.startsWith('-') || text.startsWith('+')) return null;

  const mixed = text.match(/^(\d+(?:\.\d+)?)\s+(\d+)\/(\d+)$/);
  if (mixed) {
    const whole = Number(mixed[1]);
    const numerator = Number(mixed[2]);
    const denominator = Number(mixed[3]);
    if (!Number.isFinite(whole) || denominator <= 0 || numerator < 0 || numerator >= denominator) return null;
    return whole + numerator / denominator;
  }

  const fraction = text.match(/^(\d+)\/(\d+)$/);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    if (denominator <= 0 || numerator < 0) return null;
    return numerator / denominator;
  }

  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

export function parseArchitecturalLength(raw: string): ArchitecturalLength | null {
  if (typeof raw !== 'string') return null;
  const text = normalizeMarks(raw);
  if (!text || text.includes('=') || /\b(?:NTS|NOT\s+TO\s+SCALE)\b/i.test(text)) return null;

  const feetAndInches = text.match(/^(\d+(?:\.\d+)?)\s*'\s*(?:-\s*)?(?:(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+)\s*")?$/);
  if (feetAndInches) {
    const feet = Number(feetAndInches[1]);
    const inches = feetAndInches[2] === undefined ? 0 : parseUnsignedMagnitude(feetAndInches[2]);
    if (!Number.isFinite(feet) || feet < 0 || inches === null || inches < 0 || inches >= 12) return null;
    return { feet, inches, totalFeet: feet + inches / 12 };
  }

  const inchesOnly = text.match(/^(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+)\s*"$/);
  if (inchesOnly) {
    const inches = parseUnsignedMagnitude(inchesOnly[1]);
    if (inches === null || inches < 0) return null;
    return { feet: 0, inches, totalFeet: inches / 12 };
  }

  return null;
}

export function parsePrintedArchitecturalScale(raw: string): ParsedArchitecturalScale | null {
  if (typeof raw !== 'string') return null;
  const text = normalizeMarks(raw);
  if (!text || /\b(?:NTS|NOT\s+TO\s+SCALE)\b/i.test(text)) return null;
  const match = text.match(/^(.+?)\s*"\s*=\s*(.+)$/);
  if (!match) return null;

  const paperInches = parseUnsignedMagnitude(match[1]);
  const real = parseArchitecturalLength(match[2]);
  if (paperInches === null || paperInches <= 0 || !real || real.totalFeet <= 0) return null;

  return {
    paperInches,
    realFeet: real.totalFeet,
    drawingFeetPerPdfPoint: real.totalFeet / (paperInches * 72),
  };
}

export function scaleEvidenceFromPrintedScale(raw: string): ArchitecturalScaleEvidence | null {
  const parsed = parsePrintedArchitecturalScale(raw);
  if (!parsed) return null;
  return {
    sourceType: 'printed_scale',
    drawingUnits: parsed.realFeet,
    pdfPoints: parsed.paperInches * 72,
    sourceExcerpt: normalizeMarks(raw),
  };
}

export function scaleEvidenceFromExplicitDimension(raw: string, pdfPoints: number): ArchitecturalScaleEvidence | null {
  if (!Number.isFinite(pdfPoints) || pdfPoints <= 0) return null;
  const parsed = parseArchitecturalLength(raw);
  if (!parsed || parsed.totalFeet <= 0) return null;
  return {
    sourceType: 'explicit_dimension',
    drawingUnits: parsed.totalFeet,
    pdfPoints,
    sourceExcerpt: normalizeMarks(raw),
  };
}
