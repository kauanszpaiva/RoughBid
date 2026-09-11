import {
  extractPrintedArchitecturalScaleCandidates,
  scaleEvidenceFromPrintedScale,
} from '../ml/architectural-measurement.ts';
import { calibrateScale } from './geometry.ts';
import type { ScaleCalibration, ScaleEvidence } from './types.ts';

export type DeterministicScaleDerivation = {
  version: 'scale-evidence-v1';
  evidence: ScaleEvidence[];
  calibration: ScaleCalibration;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ratioKey(evidence: ScaleEvidence): string {
  return (evidence.drawingUnits / evidence.pdfPoints).toFixed(12);
}

/**
 * Promotes strict printed-scale excerpts from an AI geometry checkpoint into
 * deterministic evidence. Equal ratios are intentionally collapsed because
 * repeated title-block text is not an independent calibration source. Different
 * ratios are preserved so whole-sheet calibration fails closed as conflicting.
 */
export function deriveDeterministicScaleEvidence(checkpoint: Record<string, unknown>): DeterministicScaleDerivation {
  const observations = Array.isArray(checkpoint.observations) ? checkpoint.observations : [];
  const byRatio = new Map<string, ScaleEvidence>();

  for (const observation of observations) {
    if (!isRecord(observation) || typeof observation.source_excerpt !== 'string') continue;
    for (const candidate of extractPrintedArchitecturalScaleCandidates(observation.source_excerpt)) {
      const evidence = scaleEvidenceFromPrintedScale(candidate);
      if (!evidence) continue;
      const key = ratioKey(evidence);
      if (!byRatio.has(key)) byRatio.set(key, evidence as ScaleEvidence);
    }
  }

  const evidence = [...byRatio.values()];
  return {
    version: 'scale-evidence-v1',
    evidence,
    calibration: calibrateScale(evidence),
  };
}

export function enrichGeometryCheckpoint(checkpoint: Record<string, unknown>): Record<string, unknown> {
  return {
    ...checkpoint,
    deterministic_scale: deriveDeterministicScaleEvidence(checkpoint),
  };
}
