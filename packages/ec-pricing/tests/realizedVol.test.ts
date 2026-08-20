import { describe, expect, it } from "vitest";
import { estimateRealizedVol, type PriceSample } from "../src/realizedVol.js";

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

function syntheticSamples(count: number, dtMs: number, dailyVol: number, seed = 1): PriceSample[] {
  // Deterministic pseudo-random walk (no Math.random dependency) so the test
  // is reproducible: a simple LCG feeding a Box-Muller transform.
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const gaussian = () => {
    const u1 = Math.max(next(), 1e-9);
    const u2 = next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };

  const perStepVol = dailyVol * Math.sqrt(dtMs / (24 * 60 * 60 * 1000));
  let price = 100;
  const samples: PriceSample[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    samples.push({ price, timestampMs: t });
    price *= Math.exp(perStepVol * gaussian());
    t += dtMs;
  }
  return samples;
}

describe("estimateRealizedVol", () => {
  it("returns null below the minimum sample count", () => {
    const samples: PriceSample[] = [
      { price: 100, timestampMs: 0 },
      { price: 101, timestampMs: 60_000 },
    ];
    expect(estimateRealizedVol(samples, { minSamples: 5 })).toBeNull();
  });

  it("returns null for zero elapsed time", () => {
    const samples: PriceSample[] = Array.from({ length: 6 }, (_, i) => ({ price: 100 + i, timestampMs: 0 }));
    expect(estimateRealizedVol(samples, { minSamples: 5 })).toBeNull();
  });

  it("returns null if any price is non-positive", () => {
    const samples: PriceSample[] = [
      { price: 100, timestampMs: 0 },
      { price: 0, timestampMs: 1000 },
      { price: 101, timestampMs: 2000 },
      { price: 102, timestampMs: 3000 },
      { price: 103, timestampMs: 4000 },
    ];
    expect(estimateRealizedVol(samples, { minSamples: 5 })).toBeNull();
  });

  it("is order-independent (sorts by timestamp internally)", () => {
    const ordered = syntheticSamples(30, 60_000, 0.5, 7);
    const shuffled = [...ordered].reverse();
    const a = estimateRealizedVol(ordered);
    const b = estimateRealizedVol(shuffled);
    expect(a).not.toBeNull();
    expect(b).toBeCloseTo(a!, 10);
  });

  it("recovers roughly the input volatility on a synthetic random walk", () => {
    // Not a tight statistical bound (realized vol from ~500 one-minute steps
    // still has meaningful sampling error), just a coarse sanity check that
    // the estimator is in the right neighborhood and not off by an order of
    // magnitude or a wrong annualization factor.
    const trueDailyVol = 0.5; // 50% daily-equivalent vol, deliberately large for signal-to-noise
    const samples = syntheticSamples(500, 60_000, trueDailyVol, 42);
    const trueAnnualVol = trueDailyVol * Math.sqrt(365.25);
    const estimate = estimateRealizedVol(samples);
    expect(estimate).not.toBeNull();
    expect(estimate!).toBeGreaterThan(trueAnnualVol * 0.5);
    expect(estimate!).toBeLessThan(trueAnnualVol * 1.5);
  });

  it("scales with the annualization factor as expected on a zero-noise case", () => {
    // Two samples one year apart with a single known log return: the
    // "annualized variance" is exactly that squared return (elapsedYears = 1).
    const logReturn = 0.1;
    const samples: PriceSample[] = [
      { price: 100, timestampMs: 0 },
      { price: 100 * Math.exp(logReturn * 0.25), timestampMs: MS_PER_YEAR * 0.25 },
      { price: 100 * Math.exp(logReturn * 0.5), timestampMs: MS_PER_YEAR * 0.5 },
      { price: 100 * Math.exp(logReturn * 0.75), timestampMs: MS_PER_YEAR * 0.75 },
      { price: 100 * Math.exp(logReturn * 1), timestampMs: MS_PER_YEAR * 1 },
    ];
    // 4 equal steps of logReturn/4 each; sum of squares = 4*(logReturn/4)^2,
    // annualized over 1 year elapsed => sqrt(4*(logReturn/4)^2) = logReturn/2.
    const estimate = estimateRealizedVol(samples, { minSamples: 5 });
    expect(estimate).toBeCloseTo(logReturn / 2, 6);
  });
});
