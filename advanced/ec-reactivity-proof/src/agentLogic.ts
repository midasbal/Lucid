// Pure planning logic for reactive-agent-v1. No I/O, no chain calls: given a
// fair-value probability and the pool's live tick, decide the two raw prices
// to quote, and given the contract's own currently-tracked order state,
// decide which side (if any) needs a fresh placeQuote call this cycle.
//
// ReactiveMaker.sol tracks bidOrderId/askOrderId itself and zeroes whichever
// side its own reactive _onEvent just cancelled. That means "does this side
// need requoting" reduces to: is the tracked orderId zero (never placed, or
// just reacted-cancelled), or is the side's own last-quoted price stale
// against a freshly computed one. Either condition, independently, on either
// side: this is why the loop can requote one side without touching the
// other, unlike v1/v2's off-chain maker which always replans both together.

export interface AgentConfig {
  /** Half-spread around fair value, in YES-probability units (e.g. 0.01 = 1%). */
  halfSpread: number;
  /** How far a side's last-quoted price must drift, in probability units, to trigger a requote. */
  requoteThreshold: number;
  /** Stop quoting and cancel everything once ttl drops under this. */
  minTtlSec: number;
}

export interface PlannedPrices {
  /** Raw on-chain price units (1e6 = 1.0 probability), tick-snapped. */
  bidPriceRaw: bigint;
  askPriceRaw: bigint;
}

const ONE_UNIT = 1_000_000n;

function clampRaw(p: bigint, tick: bigint): bigint {
  const lo = tick;
  const hi = ONE_UNIT - tick;
  if (p < lo) return lo;
  if (p > hi) return hi;
  return p;
}

function snapDown(p: bigint, tick: bigint): bigint {
  return p - (p % tick);
}

/**
 * fairYes and halfSpread are plain probabilities (0..1); the pool's tick is
 * a raw on-chain integer (1e6 scale). Bid snaps down (never overpays), ask
 * snaps down too then is nudged up one tick if that would cross or equal the
 * bid after snapping, so the two sides never collide on the same price.
 */
export function planPrices(fairYes: number, cfg: AgentConfig, tick: bigint): PlannedPrices {
  const bidRaw = BigInt(Math.round((fairYes - cfg.halfSpread) * Number(ONE_UNIT)));
  const askRaw = BigInt(Math.round((fairYes + cfg.halfSpread) * Number(ONE_UNIT)));

  let bidPriceRaw = clampRaw(snapDown(bidRaw, tick), tick);
  let askPriceRaw = clampRaw(snapDown(askRaw, tick), tick);
  if (askPriceRaw <= bidPriceRaw) askPriceRaw = clampRaw(bidPriceRaw + tick, tick);

  return { bidPriceRaw, askPriceRaw };
}

export interface SideState {
  /** The order id the contract currently tracks for this side, 0 if none resting. */
  orderId: bigint;
  /** The raw price this loop last placed that order at, undefined if never placed this session. */
  lastQuotedPriceRaw?: bigint;
}

export type RequoteReason = "never-placed" | "reacted-cancelled" | "price-drift";

export interface RequoteDecision {
  needed: boolean;
  reason?: RequoteReason;
}

/**
 * Whether one side needs a fresh placeQuote this cycle. `orderId === 0n`
 * covers both "the loop never placed this side yet" and "the reactive
 * handler just cancelled this side's sibling fill", the two are
 * indistinguishable from the contract's tracked state alone and do not need
 * to be: either way, the correct action is the same, place a fresh quote at
 * the current price.
 */
export function decideRequote(side: SideState, targetPriceRaw: bigint, thresholdRaw: bigint): RequoteDecision {
  if (side.orderId === 0n) {
    return { needed: true, reason: side.lastQuotedPriceRaw === undefined ? "never-placed" : "reacted-cancelled" };
  }
  if (side.lastQuotedPriceRaw === undefined) {
    return { needed: true, reason: "never-placed" };
  }
  const drift = targetPriceRaw > side.lastQuotedPriceRaw ? targetPriceRaw - side.lastQuotedPriceRaw : side.lastQuotedPriceRaw - targetPriceRaw;
  if (drift > thresholdRaw) {
    return { needed: true, reason: "price-drift" };
  }
  return { needed: false };
}

export function shouldPin(ttlSec: number, minTtlSec: number): boolean {
  return ttlSec < minTtlSec;
}

/** Convert a probability threshold (e.g. 0.006) to raw on-chain units for decideRequote. */
export function thresholdToRaw(threshold: number): bigint {
  return BigInt(Math.round(threshold * Number(ONE_UNIT)));
}
