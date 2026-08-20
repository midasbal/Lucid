// Cash-or-nothing binary pricer for DreamDEX event contracts.
//
// A DreamDEX up/down market is not a fixed-strike option. It resolves YES if
// the underlying's CLOSING price at expiry is at or above its OPENING price
// (the oracle answer to a reference question captured near trading start).
// So "K" here is that opening price, not a strike chosen by a trader, and the
// model below is the standard cash-or-nothing binary call/put on that K.
//
// Risk-free-rate-zero assumption: the pricer treats the underlying's
// risk-neutral drift as driftless (r = 0), so the only drift term is the
// standard Ito correction -0.5*sigma^2*T. This is a deliberate
// simplification: over the 15-minute-to-few-hour windows these markets
// actually use, funding/carry is negligible next to realized volatility, so
// a zero-rate martingale assumption is a reasonable default. It is NOT
// appropriate to reuse this pricer unmodified for long-dated instruments or
// anything with a meaningful funding basis (perps, dated futures options).

export type Side = "YES" | "NO";

export interface BinaryPriceInputs {
  /** Current underlying price (same units as openingPrice). */
  spot: number;
  /** The market's resolution reference price (the oracle-posted opening price). */
  openingPrice: number;
  /** Time to expiry in years. Use 0 (or negative, treated as 0) at/after expiry. */
  timeToExpiryYears: number;
  /** Annualized volatility of the underlying (e.g. 0.6 for 60%/year). */
  volatility: number;
}

const SQRT_2 = Math.SQRT2;

/**
 * Standard normal CDF via the Abramowitz & Stegun 7.1.26 erf approximation
 * (max absolute error ~1.5e-7). No dependency on an external stats library.
 */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / SQRT_2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

/**
 * P(underlying closes >= openingPrice at expiry) under a driftless lognormal
 * model. Returns a probability in [0, 1].
 *
 * Degenerate inputs are resolved deterministically rather than throwing,
 * since a live scan loop will hit T=0 (a market at the exact settlement
 * instant) and zero-vol inputs (a freshly booted vol estimator with no
 * samples yet) routinely:
 *   - timeToExpiryYears <= 0: no time left for the price to move, so the
 *     answer is already decided by spot vs openingPrice (ties resolve 0.5,
 *     matching the market's own void-and-split-0.5 treatment of an
 *     unresolvable comparison).
 *   - volatility <= 0: no diffusion, so again the answer is fully decided by
 *     spot vs openingPrice.
 */
export function fairYesProbability(inputs: BinaryPriceInputs): number {
  const { spot, openingPrice, timeToExpiryYears, volatility } = inputs;
  if (!(spot > 0) || !(openingPrice > 0)) {
    throw new RangeError(`fairYesProbability: spot and openingPrice must be positive (got spot=${spot}, openingPrice=${openingPrice})`);
  }

  if (timeToExpiryYears <= 0 || volatility <= 0) {
    if (spot > openingPrice) return 1;
    if (spot < openingPrice) return 0;
    return 0.5;
  }

  const d2 =
    (Math.log(spot / openingPrice) - 0.5 * volatility * volatility * timeToExpiryYears) /
    (volatility * Math.sqrt(timeToExpiryYears));
  return normalCdf(d2);
}

/** P(underlying closes < openingPrice at expiry). Exactly `1 - fairYesProbability`. */
export function fairNoProbability(inputs: BinaryPriceInputs): number {
  return 1 - fairYesProbability(inputs);
}

/** Model-fair probability for either side of the market. */
export function fairProbability(inputs: BinaryPriceInputs, side: Side): number {
  return side === "YES" ? fairYesProbability(inputs) : fairNoProbability(inputs);
}
