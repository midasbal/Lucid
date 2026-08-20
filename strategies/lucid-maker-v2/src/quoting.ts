// Pure quoting logic for Lucid's v2 maker. No I/O, no chain calls, no
// tick/lot alignment (the caller aligns to the live pool grid before
// sending an order, via lucid-core). Extends v1's skew and cap mechanics
// (strategies/lucid-maker/src/maker.ts) with a per-side half-spread, so
// vol-scaling and the trend guard can widen or pause one side without
// touching the other.

export interface VolSpreadConfig {
  /** Half-spread floor, applied even at zero measured volatility. */
  baseHalfSpread: number;
  /** Additional half-spread per unit of annualized realized volatility. */
  volMultiplier: number;
  minHalfSpread: number;
  maxHalfSpread: number;
}

/** Half-spread scaled by realized volatility: wider quotes when the underlying is moving more. */
export function scaledHalfSpread(cfg: VolSpreadConfig, volatility: number): number {
  const raw = cfg.baseHalfSpread + cfg.volMultiplier * Math.max(0, volatility);
  return Math.min(cfg.maxHalfSpread, Math.max(cfg.minHalfSpread, raw));
}

const clampProbability = (p: number, lo = 0.01, hi = 0.99): number => Math.min(hi, Math.max(lo, p));

/**
 * Probability shift from inventory skew, identical mechanics to v1: long
 * skews the quoting midpoint down (cheaper ask, further bid), short skews it
 * up, clamped to the configured cap so a position beyond the cap cannot skew
 * further than the cap itself did.
 */
export function computeSkew(netPosition: number, maxPosition: number, skewPerUnit: number): number {
  if (maxPosition <= 0) return 0;
  const frac = Math.min(1, Math.max(-1, netPosition / maxPosition));
  return frac * skewPerUnit;
}

/**
 * The position cap actually in force this cycle: the smaller of the
 * configured share cap and the (already global-budget-adjusted) notional cap
 * converted to shares at current fair value.
 */
export function effectiveMaxPosition(maxPosition: number, maxNotional: number, fairYes: number): number {
  if (fairYes <= 0) return 0;
  const notionalCapShares = maxNotional / fairYes;
  return Math.min(maxPosition, notionalCapShares);
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
  bidHalfSpread: number;
  askHalfSpread: number;
  bid: DesiredQuote;
  ask: DesiredQuote;
}

export interface PlanQuotesParams {
  fairYes: number;
  netPosition: number;
  quoteNotional: number;
  /** Effective this cycle, after portfolio.ts folds in the shared global budget. */
  maxPosition: number;
  maxNotional: number;
  skewPerUnit: number;
  bidHalfSpread: number;
  askHalfSpread: number;
  /** From the trend guard: true means do not rest this side at all this cycle. */
  pauseBid: boolean;
  pauseAsk: boolean;
}

/**
 * Compute the bid and ask this cycle wants to have resting, given fair
 * value, current inventory, and this cycle's effective caps and per-side
 * spreads. Either side can come back inactive when its position/notional cap
 * is hit or the trend guard has paused it; the other side stays active so a
 * capped-out or one-side-guarded maker still quotes its way back to flat.
 */
export function planQuotes(params: PlanQuotesParams): QuotePlan {
  const { fairYes, netPosition, quoteNotional, maxPosition, maxNotional, skewPerUnit, bidHalfSpread, askHalfSpread, pauseBid, pauseAsk } = params;

  const skew = computeSkew(netPosition, maxPosition, skewPerUnit);
  const skewedFair = clampProbability(fairYes - skew);

  const bidPrice = clampProbability(skewedFair - bidHalfSpread);
  const askPrice = clampProbability(skewedFair + askHalfSpread);

  const cap = effectiveMaxPosition(maxPosition, maxNotional, fairYes);
  const atLongCap = netPosition >= cap;
  const atShortCap = netPosition <= -cap;

  const bidSize = quoteNotional / bidPrice;
  const askSize = quoteNotional / askPrice;

  const bid: DesiredQuote = pauseBid
    ? { side: "bid", price: bidPrice, size: 0, active: false, skipReason: "trend guard: paused (fast selloff)" }
    : atLongCap
      ? { side: "bid", price: bidPrice, size: 0, active: false, skipReason: `long cap reached (net ${netPosition.toFixed(3)} >= cap ${cap.toFixed(3)})` }
      : { side: "bid", price: bidPrice, size: bidSize, active: true };

  const ask: DesiredQuote = pauseAsk
    ? { side: "ask", price: askPrice, size: 0, active: false, skipReason: "trend guard: paused (fast rally)" }
    : atShortCap
      ? { side: "ask", price: askPrice, size: 0, active: false, skipReason: `short cap reached (net ${netPosition.toFixed(3)} <= -cap ${cap.toFixed(3)})` }
      : { side: "ask", price: askPrice, size: askSize, active: true };

  return { fairYes, skewedFair, bidHalfSpread, askHalfSpread, bid, ask };
}

export interface CurrentQuotes {
  bidPrice?: number;
  askPrice?: number;
}

/**
 * Whether the resting quotes need to be replaced. True on the first cycle,
 * true when a side's active/inactive state flips (a cap or guard newly hit
 * or cleared), and true when an active side's target price has drifted past
 * requoteThreshold from what is currently resting.
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

/** Mark-to-model PnL: cash collected so far, plus the current position valued at model fair value. */
export function markToModelPnl(state: PnlState, fairYes: number): number {
  return state.cash + state.position * fairYes;
}
