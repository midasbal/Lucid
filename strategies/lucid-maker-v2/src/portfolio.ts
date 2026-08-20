// Global capital sharing across every market this maker quotes at once. Pure
// logic, no I/O: the caller supplies each market's current mark-to-model
// exposure and gets back the notional room actually available this cycle.

export interface PortfolioConfig {
  /** Hard ceiling on total mark-to-model exposure summed across every quoted market. */
  globalMaxNotional: number;
  /** Hard ceiling on any single market's own notional, regardless of how much global room is free. */
  perMarketMaxNotional: number;
  /** Hard ceiling on any single market's own share position, regardless of notional. */
  perMarketMaxPosition: number;
}

/** Mark-to-model notional of one market's position: shares held, valued at current fair value. */
export function marketNotional(netPosition: number, fairYes: number): number {
  return Math.abs(netPosition) * fairYes;
}

/** Sum of every quoted market's mark-to-model notional: the actual global exposure right now. */
export function globalExposure(markets: { netPosition: number; fairYes: number }[]): number {
  return markets.reduce((sum, m) => sum + marketNotional(m.netPosition, m.fairYes), 0);
}

/**
 * The notional cap actually in force for one market this cycle: the smaller
 * of that market's own configured ceiling and whatever global room is left
 * after every other quoted market's current exposure. A market that is
 * already flat gets to use more of the shared budget than one that is not;
 * this is deliberate, capital sharing rather than a static even split.
 */
export function effectiveMarketNotionalCap(cfg: PortfolioConfig, otherMarketsExposure: number): number {
  const globalRoom = Math.max(0, cfg.globalMaxNotional - otherMarketsExposure);
  return Math.min(cfg.perMarketMaxNotional, globalRoom);
}
