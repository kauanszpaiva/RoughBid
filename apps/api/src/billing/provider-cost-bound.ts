export interface BoundedTokenTariff {
  inputUsdPerMillion: number; outputUsdPerMillion: number;
  inputTokenLimit: number; outputTokenLimit: number;
  /** When documented, input plus all billed output share this context window. */
  combinedContextTokenLimit?: number;
  additionalRequestUsd: number;
}

/** Maximize cost over the entire accepted token region, never expected usage.
 * Callers must separately validate the source, expiry, cache policy and rates. */
export function maximumTokenCostUsd(tariff: BoundedTokenTariff): number {
  const t = tariff;
  if (![t.inputUsdPerMillion, t.outputUsdPerMillion].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0)
    || ![t.inputTokenLimit, t.outputTokenLimit].every(n => Number.isSafeInteger(n) && n > 0)
    || typeof t.additionalRequestUsd !== 'number' || !Number.isFinite(t.additionalRequestUsd) || t.additionalRequestUsd < 0
    || t.combinedContextTokenLimit !== undefined && (!Number.isSafeInteger(t.combinedContextTokenLimit) || t.combinedContextTokenLimit < 1)) {
    throw new RangeError('A complete bounded token tariff is required.');
  }
  let input = t.inputTokenLimit, output = t.outputTokenLimit;
  if (t.combinedContextTokenLimit !== undefined) {
    // A linear objective reaches its maximum by assigning the shared capacity
    // to the more expensive token class first, within each independent limit.
    if (t.outputUsdPerMillion >= t.inputUsdPerMillion) {
      output = Math.min(output, t.combinedContextTokenLimit);
      input = Math.min(input, t.combinedContextTokenLimit - output);
    } else {
      input = Math.min(input, t.combinedContextTokenLimit);
      output = Math.min(output, t.combinedContextTokenLimit - input);
    }
  }
  const cost = (input * t.inputUsdPerMillion + output * t.outputUsdPerMillion) / 1e6 + t.additionalRequestUsd;
  const rounded = Math.ceil(cost * 1e6) / 1e6;
  if (!Number.isFinite(rounded) || rounded <= 0 || !Number.isSafeInteger(Math.round(rounded * 1e6))) throw new RangeError('The token tariff exceeds supported accounting precision.');
  return rounded;
}
