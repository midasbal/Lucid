// Realized-vol estimator over a series of underlying price samples, meant to
// be fed from @somnia-chain/markets-sdk's fetchPrice/watchPrice/fetchPriceOHLCV
// (see the scan script for how to gather samples in practice).
//
// LIMITATIONS - read before trusting this number:
//
// 1. Realized variance from a short window is a high-variance estimator of
//    true forward volatility. Statistical error on a realized-vol estimate
//    scales roughly with 1/sqrt(sample count), and these event-contract
//    windows are 15 minutes to a few hours - you will rarely have more than
//    a handful of independent price samples to work with. Treat the output
//    as a rough magnitude, not a precise number.
//
// 2. It is WEAK AT VERY SHORT EXPIRIES specifically. A market with only a
//    few minutes left will often have a lookback window shorter than any
//    reasonable candle resolution, so this estimator can be fed 2-3 samples
//    or fewer. With that few points the "estimate" is close to reading the
//    realized move over one interval and calling it volatility - it is not
//    statistically meaningful. `estimateRealizedVol` returns `null` below a
//    configurable minimum sample count specifically so callers do not quietly
//    trade on a number backed by noise.
//
// 3. Crypto volatility is not stationary or Gaussian: it clusters, jumps on
//    news, and has fatter tails than a lognormal model assumes. A realized
//    estimate from the last N minutes can be well below or well above the
//    volatility that actually plays out over the remaining life of the
//    market, especially around scheduled data releases or during a
//    already-moving market.
//
// 4. This estimator has no opinion on which lookback window is "right" for a
//    given expiry. A longer lookback gives more samples (more statistical
//    power) but mixes in a regime that may no longer apply; a shorter one is
//    more current but noisier. The scan script picks one lookback per asset
//    as a starting point; tightening this is real, non-trivial work, not a
//    parameter to wave away.
//
// Given all of the above, treat this module's output as a coarse prior to
// sanity-check a market's price against, not as a trading signal on its own.

export interface PriceSample {
  /** Underlying price, in any consistent unit (must match binaryPricer's spot/openingPrice unit). */
  price: number;
  /** Sample time, Unix milliseconds. */
  timestampMs: number;
}

export interface RealizedVolOptions {
  /**
   * Minimum number of price samples required to return an estimate. Below
   * this, `estimateRealizedVol` returns null rather than a number with no
   * statistical grounding. Default 5 (4 log returns) - still noisy, but a
   * floor beneath which the number is closer to random than informative.
   */
  minSamples?: number;
}

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Annualized realized volatility from a series of underlying price samples,
 * using the realized-variance estimator (sum of squared log returns,
 * annualized by the actual elapsed time spanned by the samples). This
 * formulation tolerates irregular sampling intervals, which matters here
 * since fetchPrice/watchPrice ticks do not arrive on a fixed clock.
 *
 * Returns null if there are fewer than `minSamples` samples, if the samples
 * span zero elapsed time, or if any price is non-positive (a log return is
 * undefined there).
 */
export function estimateRealizedVol(samples: PriceSample[], options: RealizedVolOptions = {}): number | null {
  const minSamples = options.minSamples ?? 5;
  if (samples.length < minSamples) return null;
  if (samples.some((s) => !(s.price > 0))) return null;

  const sorted = [...samples].sort((a, b) => a.timestampMs - b.timestampMs);

  let sumSquaredLogReturns = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (!prev || !curr) continue;
    const logReturn = Math.log(curr.price / prev.price);
    sumSquaredLogReturns += logReturn * logReturn;
  }

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return null;
  const elapsedMs = last.timestampMs - first.timestampMs;
  if (elapsedMs <= 0) return null;

  const elapsedYears = elapsedMs / MS_PER_YEAR;
  const annualizedVariance = sumSquaredLogReturns / elapsedYears;
  return Math.sqrt(annualizedVariance);
}
