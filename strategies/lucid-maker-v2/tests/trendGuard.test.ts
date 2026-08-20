import { describe, expect, it } from "vitest";
import { computeTrend, guardAction, pruneSamples, type SpotSample, type TrendGuardConfig } from "../src/trendGuard.js";

const cfg: TrendGuardConfig = {
  lookbackMs: 60_000,
  widenThresholdPct: 0.004,
  pauseThresholdPct: 0.008,
  widenMultiplier: 3,
};

function series(prices: number[], stepMs = 10_000): SpotSample[] {
  return prices.map((price, i) => ({ price, timestampMs: i * stepMs }));
}

describe("pruneSamples", () => {
  it("drops samples older than the lookback window", () => {
    const samples = series([100, 101, 102, 103], 30_000); // t = 0, 30s, 60s, 90s
    const kept = pruneSamples(samples, 60_000, 90_000); // cutoff = 30_000
    expect(kept.map((s) => s.price)).toEqual([101, 102, 103]);
  });
});

describe("computeTrend", () => {
  it("reports none with fewer than two samples", () => {
    expect(computeTrend([{ price: 100, timestampMs: 0 }], cfg).direction).toBe("none");
    expect(computeTrend([], cfg).direction).toBe("none");
  });

  it("reports none below the widen threshold", () => {
    const samples = series([100, 100.1]); // 0.1% move
    expect(computeTrend(samples, cfg).direction).toBe("none");
  });

  it("reports up on a fast rally past the widen threshold", () => {
    const samples = series([100, 100.5]); // 0.5% move
    const trend = computeTrend(samples, cfg);
    expect(trend.direction).toBe("up");
    expect(trend.movePct).toBeCloseTo(0.005, 6);
  });

  it("reports down on a fast selloff past the widen threshold", () => {
    const samples = series([100, 99.5]); // -0.5% move
    const trend = computeTrend(samples, cfg);
    expect(trend.direction).toBe("down");
    expect(trend.movePct).toBeCloseTo(-0.005, 6);
  });

  it("measures from the oldest to the newest sample in the window, not peak to trough", () => {
    const samples = series([100, 103, 100.2]); // spikes up then comes back near flat
    const trend = computeTrend(samples, cfg);
    expect(trend.movePct).toBeCloseTo(0.002, 6);
    expect(trend.direction).toBe("none");
  });
});

describe("guardAction", () => {
  it("takes no action when the trend is none", () => {
    const action = guardAction({ direction: "none", movePct: 0 }, cfg);
    expect(action.pauseBid).toBe(false);
    expect(action.pauseAsk).toBe(false);
    expect(action.bidWidenMultiplier).toBe(1);
    expect(action.askWidenMultiplier).toBe(1);
  });

  it("widens only the ask on a rally below the pause threshold", () => {
    const action = guardAction({ direction: "up", movePct: 0.005 }, cfg);
    expect(action.pauseAsk).toBe(false);
    expect(action.askWidenMultiplier).toBe(3);
    expect(action.pauseBid).toBe(false);
    expect(action.bidWidenMultiplier).toBe(1);
  });

  it("pauses the ask outright on a rally past the pause threshold", () => {
    const action = guardAction({ direction: "up", movePct: 0.01 }, cfg);
    expect(action.pauseAsk).toBe(true);
    expect(action.pauseBid).toBe(false);
  });

  it("widens only the bid on a selloff below the pause threshold", () => {
    const action = guardAction({ direction: "down", movePct: -0.005 }, cfg);
    expect(action.pauseBid).toBe(false);
    expect(action.bidWidenMultiplier).toBe(3);
    expect(action.pauseAsk).toBe(false);
    expect(action.askWidenMultiplier).toBe(1);
  });

  it("pauses the bid outright on a selloff past the pause threshold", () => {
    const action = guardAction({ direction: "down", movePct: -0.01 }, cfg);
    expect(action.pauseBid).toBe(true);
    expect(action.pauseAsk).toBe(false);
  });
});
