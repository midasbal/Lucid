import { describe, expect, it } from "vitest";
import { fairNoProbability, fairYesProbability } from "../src/binaryPricer.js";

describe("fairYesProbability", () => {
  it("is close to 1 deep in the money", () => {
    const p = fairYesProbability({
      spot: 100,
      openingPrice: 60,
      timeToExpiryYears: 15 / (365.25 * 24 * 60),
      volatility: 0.6,
    });
    expect(p).toBeGreaterThan(0.999);
  });

  it("is close to 0 deep out of the money", () => {
    const p = fairYesProbability({
      spot: 60,
      openingPrice: 100,
      timeToExpiryYears: 15 / (365.25 * 24 * 60),
      volatility: 0.6,
    });
    expect(p).toBeLessThan(0.001);
  });

  it("is near 0.5 at the money, adjusted down for time and vol", () => {
    const T = 15 / (365.25 * 24 * 60);
    const sigma = 0.6;
    const p = fairYesProbability({ spot: 100, openingPrice: 100, timeToExpiryYears: T, volatility: sigma });
    // At S = K, d2 = -0.5 * sigma * sqrt(T) < 0, so YES is priced strictly
    // below 0.5 (the driftless model's median sits below the mean).
    expect(p).toBeLessThan(0.5);
    expect(p).toBeGreaterThan(0.45);

    // Bigger vol-time product pushes it further below 0.5.
    const pMoreVol = fairYesProbability({ spot: 100, openingPrice: 100, timeToExpiryYears: T, volatility: sigma * 3 });
    expect(pMoreVol).toBeLessThan(p);
  });

  it("YES and NO sum to 1", () => {
    const inputs = { spot: 101, openingPrice: 100, timeToExpiryYears: 0.001, volatility: 0.8 };
    expect(fairYesProbability(inputs) + fairNoProbability(inputs)).toBeCloseTo(1, 10);
  });

  it("resolves deterministically at T = 0", () => {
    const base = { openingPrice: 100, timeToExpiryYears: 0, volatility: 0.6 };
    expect(fairYesProbability({ ...base, spot: 101 })).toBe(1);
    expect(fairYesProbability({ ...base, spot: 99 })).toBe(0);
    expect(fairYesProbability({ ...base, spot: 100 })).toBe(0.5);
  });

  it("resolves deterministically at zero volatility", () => {
    const base = { openingPrice: 100, timeToExpiryYears: 0.01, volatility: 0 };
    expect(fairYesProbability({ ...base, spot: 101 })).toBe(1);
    expect(fairYesProbability({ ...base, spot: 99 })).toBe(0);
  });

  it("is strictly monotonic increasing in spot for fixed opening/T/vol", () => {
    // Realistic short-dated moves (fractions of a percent around opening),
    // not the +/-20% swings a 30-minute crypto window never actually sees.
    // Wide swings are covered separately by the deep ITM/OTM cases above,
    // where the model correctly (and un-testably-strictly, see below)
    // saturates to float64's nearest representable value to 0 or 1.
    const T = 30 / (365.25 * 24 * 60);
    const sigma = 0.5;
    const spots = [98.5, 99, 99.5, 99.8, 100, 100.2, 100.5, 101, 101.5];
    const probs = spots.map((spot) => fairYesProbability({ spot, openingPrice: 100, timeToExpiryYears: T, volatility: sigma }));
    for (let i = 1; i < probs.length; i++) {
      expect(probs[i]!).toBeGreaterThan(probs[i - 1]!);
    }
  });

  it("decays monotonically toward the T=0 outcome as expiry approaches, in-the-money", () => {
    // For a fixed in-the-money spot vs opening, probability rises toward 1 as
    // T shrinks (less time for the price to fall back below opening). Kept
    // inside the well-conditioned range (d2 magnitude a few units, not
    // dozens) so float64 does not saturate two adjacent points to the same
    // value and mask the ordering; see binaryPricer.ts's normalCdf for why
    // very large |d2| saturates.
    const sigma = 0.5;
    const minutesToExpiry = [90, 60, 30, 15, 8, 4];
    const probs = minutesToExpiry.map((m) =>
      fairYesProbability({ spot: 100.3, openingPrice: 100, timeToExpiryYears: m / (365.25 * 24 * 60), volatility: sigma }),
    );
    for (let i = 1; i < probs.length; i++) {
      expect(probs[i]!).toBeGreaterThan(probs[i - 1]!);
    }
  });

  it("decays monotonically toward the T=0 outcome as expiry approaches, out-of-the-money", () => {
    const sigma = 0.5;
    const minutesToExpiry = [90, 60, 30, 15, 8, 4];
    const probs = minutesToExpiry.map((m) =>
      fairYesProbability({ spot: 99.7, openingPrice: 100, timeToExpiryYears: m / (365.25 * 24 * 60), volatility: sigma }),
    );
    for (let i = 1; i < probs.length; i++) {
      expect(probs[i]!).toBeLessThan(probs[i - 1]!);
    }
  });

  it("rejects non-positive spot or opening price", () => {
    expect(() => fairYesProbability({ spot: 0, openingPrice: 100, timeToExpiryYears: 0.01, volatility: 0.5 })).toThrow();
    expect(() => fairYesProbability({ spot: 100, openingPrice: -1, timeToExpiryYears: 0.01, volatility: 0.5 })).toThrow();
  });
});
