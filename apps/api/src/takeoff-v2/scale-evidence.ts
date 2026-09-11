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
 * Promotes native-PDF and AI-observed printed scales into one deterministic
 * evidence set. Equal ratios are intentionally collapsed because repeated text
 * is not an independent calibration source. Different ratios are preserved so
 * whole-sheet calibration fails closed as conflicting.
 */
export function deriveDeterministicScaleEvidence(
  checkpoint: Record<string, unknown>,
  nativeScaleCandidates: readonly string[] = [],
): DeterministicScaleDerivation {
  const observations = Array.isArray(checkpoint.observations) ? checkpoint.observations : [];
  const byRatio = new Map<string, ScaleEvidence>();

  const addCandidate = (candidate: string) => {
    const evidence = scaleEvidenceFromPrintedScale(candidate);
    if (!evidence) return;
    const key = ratioKey(evidence);
    if (!byRatio.has(key)) byRatio.set(key, evidence as ScaleEvidence);
  };

  for (const candidate of nativeScaleCandidates) {
    if (typeof candidate === 'string') addCandidate(candidate);
  }

  for (const observation of observations) {
    if (!isRecord(observation) || typeof observation.source_excerpt !== 'string') continue;
    for (const candidate of extractPrintedArchitecturalScaleCandidates(observation.source_excerpt)) addCandidate(candidate);
  }

  const evidence = [...byRatio.values()];
  return {
    version: 'scale-evidence-v1',
    evidence,
    calibration: calibrateScale(evidence),
  };
}

export function enrichGeometryCheckpoint(
  checkpoint: Record<string, unknown>,
  nativeScaleCandidates: readonly string[] = [],
): Record<string, unknown> {
  return {
    ...checkpoint,
    deterministic_scale: deriveDeterministicScaleEvidence(checkpoint, nativeScaleCandidates),
  };
}
