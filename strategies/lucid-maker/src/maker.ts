// Pure quoting logic for Lucid's fair-value maker. No I/O, no chain calls, no
// tick/lot alignment (the caller aligns to the live pool grid before sending
// an order). Kept separate from index.ts so the decision logic is testable
// without a wallet or a live market.

export interface MakerConfig {
  /** Half-spread around fair value, in YES-probability units (e.g. 0.02 = 2%). */
  halfSpread: number;
  /** Target notional per quoted side, in collateral units (tUSDC). */
  quoteNotional: number;
  /** Hard cap on absolute net YES position, in shares. */
  maxPosition: number;
  /** Hard cap on total mark-to-model notional exposure, in collateral units. */
  maxNotional: number;
  /**
   * How far fair value shifts, in probability units, per full unit of
   * position-cap utilization. At netPosition == maxPosition the quote
   * midpoint shifts down by exactly this much, making the ask more
   * aggressive (closer to true fair, more likely to fill) and the bid less
   * aggressive, so a long position mean-reverts toward flat.
   */
  skewPerUnit: number;
  /** Minimum price move away from the last quote to trigger a requote. */
  requoteThreshold: number;
}

export interface DesiredQuote {
  side: "bid" | "ask";
  /** YES probability, not yet tick-aligned. */
  price: number;
  /** Shares, not yet lot-aligned. */
  size: number;
  active: boolean;
  skipReason?: string;
}

export interface QuotePlan {
  fairYes: number;
  skewedFair: number;
  bid: DesiredQuote;
  ask: DesiredQuote;
}

const clampProbability = (p: number, lo = 0.01, hi = 0.99): number => Math.min(hi, Math.max(lo, p));

/**
 * Probability shift from inventory skew. Long (netPosition > 0) skews the
 * quoting midpoint DOWN, which lowers both the bid and the ask: the ask sits
 * closer to true fair value (cheaper to hit, more likely to sell down the
 * position) and the bid sits further below fair (less eager to add more
 * length). Short skews the opposite way. Clamped to [-1, 1] full-cap units
 * so a position beyond the cap cannot skew further than the cap itself did.
 */
export function computeSkew(netPosition: number, maxPosition: number, skewPerUnit: number): number {
  if (maxPosition <= 0) return 0;
  const frac = Math.min(1, Math.max(-1, netPosition / maxPosition));
  return frac * skewPerUnit;
}

/**
 * The position cap actually in force this cycle: the smaller of the
 * configured share cap and the notional cap converted to shares at the
 * current fair value. A market moving fair value up shrinks the effective
 * share cap for the same notional ceiling, which is the intended behavior,
 * not a bug: the notional cap is the harder constraint by design.
 */
export function effectiveMaxPosition(cfg: MakerConfig, fairYes: number): number {
  if (fairYes <= 0) return 0;
  const notionalCapShares = cfg.maxNotional / fairYes;
  return Math.min(cfg.maxPosition, notionalCapShares);
}

/**
 * Compute the bid and ask this cycle wants to have resting, given fair value
 * and current inventory. Either side can come back inactive (size 0) when
 * the position or notional cap on that side of the book is already hit;
 * the other side stays active so a capped-out maker still quotes its way
 * back to flat.
 */
export function planQuotes(params: { fairYes: number; netPosition: number; cfg: MakerConfig }): QuotePlan {
  const { fairYes, netPosition, cfg } = params;
  const skew = computeSkew(netPosition, cfg.maxPosition, cfg.skewPerUnit);
  const skewedFair = clampProbability(fairYes - skew);

  const bidPrice = clampProbability(skewedFair - cfg.halfSpread);
  const askPrice = clampProbability(skewedFair + cfg.halfSpread);

  const cap = effectiveMaxPosition(cfg, fairYes);
  const atLongCap = netPosition >= cap;
  const atShortCap = netPosition <= -cap;

  const bidSize = cfg.quoteNotional / bidPrice;
  const askSize = cfg.quoteNotional / askPrice;

  const bid: DesiredQuote = atLongCap
    ? { side: "bid", price: bidPrice, size: 0, active: false, skipReason: `long cap reached (net ${netPosition.toFixed(3)} >= cap ${cap.toFixed(3)})` }
    : { side: "bid", price: bidPrice, size: bidSize, active: true };

  const ask: DesiredQuote = atShortCap
    ? { side: "ask", price: askPrice, size: 0, active: false, skipReason: `short cap reached (net ${netPosition.toFixed(3)} <= -cap ${cap.toFixed(3)})` }
    : { side: "ask", price: askPrice, size: askSize, active: true };

  return { fairYes, skewedFair, bid, ask };
}

export interface CurrentQuotes {
  bidPrice?: number;
  askPrice?: number;
}

/**
 * Whether the resting quotes need to be replaced. True on the first cycle
 * (nothing resting yet against an active plan), true when a side's
 * active/inactive state flips (a cap was hit or cleared), and true when an
 * active side's target price has drifted past requoteThreshold from what is
 * currently resting. Small, sub-threshold drift returns false so the maker
 * does not cancel and repost every cycle over noise.
 */
export function shouldRequote(current: CurrentQuotes, planned: QuotePlan, requoteThreshold: number): boolean {
  const sideChanged = (currentPrice: number | undefined, target: DesiredQuote): boolean => {
    if (!target.active) return currentPrice !== undefined;
    if (currentPrice === undefined) return true;
    return Math.abs(currentPrice - target.price) > requoteThreshold;
  };
  return sideChanged(current.bidPrice, planned.bid) || sideChanged(current.askPrice, planned.ask);
}

export function shouldPinRisk(ttlSec: number, minTtlSec: number): boolean {
  return ttlSec < minTtlSec;
}

export interface Fill {
  side: "buy" | "sell";
  price: number;
  size: number;
}

export interface PnlState {
  /** Cumulative cash flow from fills: negative when net spent, positive when net received. */
  cash: number;
  /** Net YES shares held from this maker's own fills. */
  position: number;
}

export const INITIAL_PNL_STATE: PnlState = { cash: 0, position: 0 };

export function applyFill(state: PnlState, fill: Fill): PnlState {
  const signedSize = fill.side === "buy" ? fill.size : -fill.size;
  const cashDelta = fill.side === "buy" ? -fill.price * fill.size : fill.price * fill.size;
  return { cash: state.cash + cashDelta, position: state.position + signedSize };
}

/**
 * Mark-to-model PnL: cash collected so far, plus the current position valued
 * at model fair value. Not a real settlement value (the market has not
 * resolved), a running estimate of what this maker's activity is worth if
 * fair value is right.
 */
export function markToModelPnl(state: PnlState, fairYes: number): number {
  return state.cash + state.position * fairYes;
}
