// Bounded, rule-based adverse-selection guard. Not a predictive model: it
// only measures how far the underlying has actually moved over a short
// lookback and reacts. A fast rally is a threat to a resting ask (someone
// buys YES from us right before the market reprices it higher); a fast
// selloff is a threat to a resting bid (someone sells YES to us right before
// it reprices lower). The guard widens the threatened side first, and only
// pauses it outright once the move is large enough that widening is not
// enough.

export interface SpotSample {
  price: number;
  timestampMs: number;
}

export interface TrendGuardConfig {
  /** How far back to measure the move, in milliseconds. */
  lookbackMs: number;
  /** Move over the lookback, as a fraction of price, that first triggers widening. */
  widenThresholdPct: number;
  /** Larger move that fully pauses the threatened side instead of just widening it. */
  pauseThresholdPct: number;
  /** Multiplier applied to the threatened side's half-spread while widened but not paused. */
  widenMultiplier: number;
}

export type TrendDirection = "up" | "down" | "none";

export interface TrendState {
  direction: TrendDirection;
  /** Signed fractional move over the lookback window: positive is up. */
  movePct: number;
}

/** Drop samples older than the lookback window, keeping the array sorted oldest-first. */
export function pruneSamples(samples: SpotSample[], lookbackMs: number, nowMs: number): SpotSample[] {
  const cutoff = nowMs - lookbackMs;
  return samples.filter((s) => s.timestampMs >= cutoff);
}

/**
 * Fractional move from the oldest sample still in the lookback window to the
 * newest. Needs at least two samples in the window to say anything; fewer
 * than that returns "none" rather than a noisy reading off a single point.
 */
export function computeTrend(samples: SpotSample[], cfg: TrendGuardConfig): TrendState {
  if (samples.length < 2) return { direction: "none", movePct: 0 };
  const first = samples[0]?.price;
  const last = samples[samples.length - 1]?.price;
  if (first === undefined || last === undefined || first <= 0) return { direction: "none", movePct: 0 };
  const movePct = (last - first) / first;
  if (Math.abs(movePct) < cfg.widenThresholdPct) return { direction: "none", movePct };
  return { direction: movePct > 0 ? "up" : "down", movePct };
}

export interface GuardAction {
  pauseBid: boolean;
  pauseAsk: boolean;
  /** 1 = no widening. Applies only to the threatened side; the safe side quotes at its normal spread. */
  bidWidenMultiplier: number;
  askWidenMultiplier: number;
  reason?: string;
}

const NO_ACTION: GuardAction = { pauseBid: false, pauseAsk: false, bidWidenMultiplier: 1, askWidenMultiplier: 1 };

export function guardAction(trend: TrendState, cfg: TrendGuardConfig): GuardAction {
  if (trend.direction === "none") return NO_ACTION;

  const movePctAbs = Math.abs(trend.movePct);
  const paused = movePctAbs >= cfg.pauseThresholdPct;
  const movePctStr = `${(trend.movePct * 100).toFixed(3)}%`;

  if (trend.direction === "up") {
    return {
      pauseBid: false,
      pauseAsk: paused,
      bidWidenMultiplier: 1,
      askWidenMultiplier: paused ? 1 : cfg.widenMultiplier,
      reason: `underlying up ${movePctStr} over lookback, ${paused ? "pausing ask" : "widening ask"}`,
    };
  }
  return {
    pauseBid: paused,
    pauseAsk: false,
    bidWidenMultiplier: paused ? 1 : cfg.widenMultiplier,
    askWidenMultiplier: 1,
    reason: `underlying down ${movePctStr} over lookback, ${paused ? "pausing bid" : "widening bid"}`,
  };
}
