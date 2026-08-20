// Pure math, no dependencies, so this stays trivially unit-testable in
// isolation from the SDK. Split out of market.ts for exactly that reason.

/**
 * The oracle's opening-price numericValue carries no documented decimals
 * field. Infer its scale at runtime against a fresh spot reading: round the
 * ratio to the nearest power of ten, since a real spot and a real opening
 * price for the same asset are always within one order of magnitude of each
 * other, never arbitrarily far apart.
 */
export function inferScale(rawNumericValue: number, referencePrice: number): number {
  const ratio = referencePrice / rawNumericValue;
  const exponent = Math.round(Math.log10(ratio));
  return 10 ** exponent;
}
