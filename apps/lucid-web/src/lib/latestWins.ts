/**
 * Guards a poll loop's own state commits against out-of-order async
 * results. Every one of this app's poll hooks (useBoard, usePortfolio,
 * usePosition, useCandles) runs an async tick() on a fixed setInterval,
 * with no guarantee that ticks finish in the order they started: a slow
 * round trip from an earlier tick can resolve after a faster, more recent
 * tick already committed fresh state, silently overwriting it with stale
 * data on a screen the user may be actively trading against. The
 * pre-existing "cancelled" flag in each hook only guards unmount and
 * dependency change, never this.
 *
 * Framework-agnostic and pure so it can be unit-tested without React: call
 * start() at the beginning of each attempt to get a token, then check
 * isCurrent(token) before committing that attempt's result. Only the
 * most-recently-started attempt's token is ever current, regardless of
 * which attempt's async work actually finishes first.
 */
export interface LatestWinsGate {
  start(): number;
  isCurrent(token: number): boolean;
}

export function createLatestWinsGate(): LatestWinsGate {
  let current = 0;
  return {
    start(): number {
      current += 1;
      return current;
    },
    isCurrent(token: number): boolean {
      return token === current;
    },
  };
}
