import { describe, expect, it } from "vitest";
import { applyFill, computeSkew, effectiveMaxPosition, INITIAL_PNL_STATE, markToModelPnl, planQuotes, scaledHalfSpread, shouldPinRisk, shouldRequote } from "../src/quoting.js";

describe("computeSkew", () => {
  it("is zero at zero inventory", () => {
    expect(computeSkew(0, 20, 0.03)).toBe(0);
  });
  it("is positive skewPerUnit at the long cap", () => {
    expect(computeSkew(20, 20, 0.03)).toBeCloseTo(0.03, 10);
  });
  it("is negative skewPerUnit at the short cap", () => {
    expect(computeSkew(-20, 20, 0.03)).toBeCloseTo(-0.03, 10);
  });
  it("clamps beyond the cap rather than overshooting", () => {
    expect(computeSkew(40, 20, 0.03)).toBeCloseTo(0.03, 10);
  });
});

describe("effectiveMaxPosition", () => {
  it("uses the share cap when it is the tighter constraint", () => {
    expect(effectiveMaxPosition(20, 1000, 0.5)).toBe(20);
  });
  it("uses the notional cap when it is the tighter constraint", () => {
    expect(effectiveMaxPosition(20, 5, 0.5)).toBe(10);
  });
});

describe("scaledHalfSpread", () => {
  const cfg = { baseHalfSpread: 0.005, volMultiplier: 0.02, minHalfSpread: 0.003, maxHalfSpread: 0.05 };
  it("is the base half-spread at zero volatility", () => {
    expect(scaledHalfSpread(cfg, 0)).toBeCloseTo(0.005, 10);
  });
  it("widens with higher volatility", () => {
    const low = scaledHalfSpread(cfg, 0.3);
    const high = scaledHalfSpread(cfg, 1.2);
    expect(high).toBeGreaterThan(low);
  });
  it("never exceeds the configured max", () => {
    expect(scaledHalfSpread(cfg, 100)).toBe(0.05);
  });
  it("treats negative volatility as zero rather than reducing the spread further", () => {
    expect(scaledHalfSpread(cfg, -5)).toBeCloseTo(0.005, 10);
  });

  it("never drops below the configured min", () => {
    const tightCfg = { ...cfg, baseHalfSpread: 0.001 };
    expect(scaledHalfSpread(tightCfg, 0)).toBe(0.003);
  });
});

describe("planQuotes", () => {
  const base = {
    fairYes: 0.4,
    netPosition: 0,
    quoteNotional: 5,
    maxPosition: 20,
    maxNotional: 1000,
    skewPerUnit: 0.03,
    bidHalfSpread: 0.02,
    askHalfSpread: 0.02,
    pauseBid: false,
    pauseAsk: false,
  };

  it("straddles fair value symmetrically at zero inventory and equal spreads", () => {
    const plan = planQuotes(base);
    expect(plan.bid.price).toBeCloseTo(0.38, 10);
    expect(plan.ask.price).toBeCloseTo(0.42, 10);
    expect(plan.bid.active).toBe(true);
    expect(plan.ask.active).toBe(true);
  });

  it("widening only the ask leaves the bid untouched", () => {
    const plan = planQuotes({ ...base, askHalfSpread: 0.06 });
    expect(plan.bid.price).toBeCloseTo(0.38, 10);
    expect(plan.ask.price).toBeCloseTo(0.46, 10);
  });

  it("pausing the ask deactivates only the ask", () => {
    const plan = planQuotes({ ...base, pauseAsk: true });
    expect(plan.ask.active).toBe(false);
    expect(plan.ask.skipReason).toMatch(/trend guard/);
    expect(plan.bid.active).toBe(true);
  });

  it("pausing the bid deactivates only the bid", () => {
    const plan = planQuotes({ ...base, pauseBid: true });
    expect(plan.bid.active).toBe(false);
    expect(plan.bid.skipReason).toMatch(/trend guard/);
    expect(plan.ask.active).toBe(true);
  });

  it("skips the bid once the long cap is reached", () => {
    const plan = planQuotes({ ...base, netPosition: 20, maxPosition: 20 });
    expect(plan.bid.active).toBe(false);
    expect(plan.ask.active).toBe(true);
  });

  it("skips the ask once the short cap is reached", () => {
    const plan = planQuotes({ ...base, netPosition: -20, maxPosition: 20 });
    expect(plan.ask.active).toBe(false);
    expect(plan.bid.active).toBe(true);
  });
});

describe("shouldRequote", () => {
  const plan = planQuotes({
    fairYes: 0.4,
    netPosition: 0,
    quoteNotional: 5,
    maxPosition: 20,
    maxNotional: 1000,
    skewPerUnit: 0.03,
    bidHalfSpread: 0.02,
    askHalfSpread: 0.02,
    pauseBid: false,
    pauseAsk: false,
  });

  it("is true with nothing currently resting", () => {
    expect(shouldRequote({}, plan, 0.005)).toBe(true);
  });
  it("is false when current quotes already match within threshold", () => {
    expect(shouldRequote({ bidPrice: plan.bid.price, askPrice: plan.ask.price }, plan, 0.005)).toBe(false);
  });
  it("is true when a side has drifted past threshold", () => {
    expect(shouldRequote({ bidPrice: plan.bid.price - 0.01, askPrice: plan.ask.price }, plan, 0.005)).toBe(true);
  });
});

describe("shouldPinRisk", () => {
  it("pins once ttl drops under the floor", () => {
    expect(shouldPinRisk(100, 150)).toBe(true);
    expect(shouldPinRisk(200, 150)).toBe(false);
  });
});

describe("pnl", () => {
  it("tracks cash and position across fills", () => {
    let state = INITIAL_PNL_STATE;
    state = applyFill(state, { side: "buy", price: 0.4, size: 10 });
    state = applyFill(state, { side: "sell", price: 0.5, size: 4 });
    expect(state.position).toBeCloseTo(6, 10);
    expect(state.cash).toBeCloseTo(-4 + 2, 10);
    expect(markToModelPnl(state, 0.45)).toBeCloseTo(state.cash + 6 * 0.45, 10);
  });
});
