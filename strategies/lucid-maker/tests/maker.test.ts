import { describe, expect, it } from "vitest";
import { applyFill, computeSkew, effectiveMaxPosition, INITIAL_PNL_STATE, markToModelPnl, planQuotes, shouldPinRisk, shouldRequote } from "../src/maker.js";

const baseCfg = {
  halfSpread: 0.02,
  quoteNotional: 5,
  maxPosition: 20,
  maxNotional: 1000,
  skewPerUnit: 0.03,
  requoteThreshold: 0.005,
};

describe("computeSkew", () => {
  it("is zero at zero inventory", () => {
    expect(computeSkew(0, 20, 0.03)) .toBe(0);
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
    // fair 0.5, notional cap 1000 -> 2000 shares, share cap 20 is tighter
    expect(effectiveMaxPosition(baseCfg, 0.5)).toBe(20);
  });
  it("uses the notional cap when it is the tighter constraint", () => {
    const cfg = { ...baseCfg, maxNotional: 5 };
    // fair 0.5 -> notional cap = 10 shares, tighter than the 20-share cap
    expect(effectiveMaxPosition(cfg, 0.5)).toBe(10);
  });
});

describe("planQuotes", () => {
  it("straddles fair value symmetrically at zero inventory", () => {
    const plan = planQuotes({ fairYes: 0.5, netPosition: 0, cfg: baseCfg });
    expect(plan.skewedFair).toBeCloseTo(0.5, 10);
    expect(plan.bid.price).toBeCloseTo(0.48, 10);
    expect(plan.ask.price).toBeCloseTo(0.52, 10);
    expect(plan.bid.active).toBe(true);
    expect(plan.ask.active).toBe(true);
  });

  it("skews both quotes down when long, making the ask more aggressive", () => {
    const plan = planQuotes({ fairYes: 0.5, netPosition: 10, cfg: baseCfg });
    // skew at half the cap = 0.015 down
    expect(plan.skewedFair).toBeCloseTo(0.485, 10);
    expect(plan.ask.price).toBeLessThan(0.52);
    expect(plan.bid.price).toBeLessThan(0.48);
  });

  it("deactivates the bid once the long cap is hit", () => {
    const plan = planQuotes({ fairYes: 0.5, netPosition: 20, cfg: baseCfg });
    expect(plan.bid.active).toBe(false);
    expect(plan.ask.active).toBe(true);
  });

  it("deactivates the ask once the short cap is hit", () => {
    const plan = planQuotes({ fairYes: 0.5, netPosition: -20, cfg: baseCfg });
    expect(plan.ask.active).toBe(false);
    expect(plan.bid.active).toBe(true);
  });

  it("sizes each side to the configured notional at that side's own price", () => {
    const plan = planQuotes({ fairYes: 0.5, netPosition: 0, cfg: baseCfg });
    expect(plan.bid.size).toBeCloseTo(baseCfg.quoteNotional / plan.bid.price, 10);
    expect(plan.ask.size).toBeCloseTo(baseCfg.quoteNotional / plan.ask.price, 10);
  });
});

describe("shouldRequote", () => {
  it("is true on the first cycle with nothing resting", () => {
    const plan = planQuotes({ fairYes: 0.5, netPosition: 0, cfg: baseCfg });
    expect(shouldRequote({}, plan, baseCfg.requoteThreshold)).toBe(true);
  });

  it("is false when resting quotes already match within threshold", () => {
    const plan = planQuotes({ fairYes: 0.5, netPosition: 0, cfg: baseCfg });
    const current = { bidPrice: plan.bid.price, askPrice: plan.ask.price };
    expect(shouldRequote(current, plan, baseCfg.requoteThreshold)).toBe(false);
  });

  it("is true when fair value drifts past the threshold", () => {
    const before = planQuotes({ fairYes: 0.5, netPosition: 0, cfg: baseCfg });
    const current = { bidPrice: before.bid.price, askPrice: before.ask.price };
    const after = planQuotes({ fairYes: 0.55, netPosition: 0, cfg: baseCfg });
    expect(shouldRequote(current, after, baseCfg.requoteThreshold)).toBe(true);
  });

  it("is false for sub-threshold drift, to avoid needless churn", () => {
    const before = planQuotes({ fairYes: 0.5, netPosition: 0, cfg: baseCfg });
    const current = { bidPrice: before.bid.price, askPrice: before.ask.price };
    const after = planQuotes({ fairYes: 0.5001, netPosition: 0, cfg: baseCfg });
    expect(shouldRequote(current, after, baseCfg.requoteThreshold)).toBe(false);
  });

  it("is true when a cap newly deactivates a side that was resting", () => {
    const before = planQuotes({ fairYes: 0.5, netPosition: 19, cfg: baseCfg });
    const current = { bidPrice: before.bid.price, askPrice: before.ask.price };
    const after = planQuotes({ fairYes: 0.5, netPosition: 20, cfg: baseCfg });
    expect(shouldRequote(current, after, baseCfg.requoteThreshold)).toBe(true);
  });
});

describe("shouldPinRisk", () => {
  it("pins risk once ttl drops under the floor", () => {
    expect(shouldPinRisk(120, 180)).toBe(true);
    expect(shouldPinRisk(240, 180)).toBe(false);
  });
});

describe("pnl tracking", () => {
  it("starts flat", () => {
    expect(markToModelPnl(INITIAL_PNL_STATE, 0.5)).toBe(0);
  });

  it("buying then marking at a higher fair value shows a gain", () => {
    const afterBuy = applyFill(INITIAL_PNL_STATE, { side: "buy", price: 0.4, size: 10 });
    expect(afterBuy.cash).toBeCloseTo(-4, 10);
    expect(afterBuy.position).toBe(10);
    expect(markToModelPnl(afterBuy, 0.5)).toBeCloseTo(1, 10); // -4 + 10*0.5
  });

  it("a round trip buy then sell at the same price nets zero", () => {
    const afterBuy = applyFill(INITIAL_PNL_STATE, { side: "buy", price: 0.4, size: 10 });
    const afterSell = applyFill(afterBuy, { side: "sell", price: 0.4, size: 10 });
    expect(afterSell.position).toBe(0);
    expect(markToModelPnl(afterSell, 0.6)).toBeCloseTo(0, 10);
  });

  it("capturing the spread on a round trip is a real gain", () => {
    const afterBuy = applyFill(INITIAL_PNL_STATE, { side: "buy", price: 0.48, size: 10 });
    const afterSell = applyFill(afterBuy, { side: "sell", price: 0.52, size: 10 });
    expect(markToModelPnl(afterSell, 0.5)).toBeCloseTo(0.4, 10); // 10 * (0.52 - 0.48)
  });
});
