import { describe, expect, it } from "vitest";
import { effectiveMarketNotionalCap, globalExposure, marketNotional, type PortfolioConfig } from "../src/portfolio.js";

describe("marketNotional", () => {
  it("values a position at fair yes, direction-agnostic", () => {
    expect(marketNotional(4, 0.4)).toBeCloseTo(1.6, 10);
    expect(marketNotional(-4, 0.4)).toBeCloseTo(1.6, 10);
  });
});

describe("globalExposure", () => {
  it("sums notional across every market", () => {
    const markets = [
      { netPosition: 4, fairYes: 0.4 },
      { netPosition: -2, fairYes: 0.6 },
    ];
    expect(globalExposure(markets)).toBeCloseTo(1.6 + 1.2, 10);
  });
  it("is zero with no markets", () => {
    expect(globalExposure([])).toBe(0);
  });
});

describe("effectiveMarketNotionalCap", () => {
  const cfg: PortfolioConfig = { globalMaxNotional: 12, perMarketMaxNotional: 6, perMarketMaxPosition: 20 };

  it("uses the per-market cap when global room is plentiful", () => {
    expect(effectiveMarketNotionalCap(cfg, 0)).toBe(6);
  });

  it("shrinks to the remaining global room once other markets have used it up", () => {
    expect(effectiveMarketNotionalCap(cfg, 9)).toBeCloseTo(3, 10);
  });

  it("floors at zero rather than going negative", () => {
    expect(effectiveMarketNotionalCap(cfg, 20)).toBe(0);
  });

  it("lets a flat market use the full per-market cap even with other markets active, as long as global room allows", () => {
    expect(effectiveMarketNotionalCap(cfg, 5)).toBe(6);
  });
});
