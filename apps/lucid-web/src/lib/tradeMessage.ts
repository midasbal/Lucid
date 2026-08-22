/**
 * Shared validation and result-messaging for the buy and close-position
 * flows. Pure, framework-agnostic, no chain calls, so both are directly
 * testable without a wallet or a live market.
 */

/** A size typed into a trade or close-size input is safe to send only when
 *  it is a real, positive, finite number. Catches an empty/cleared field
 *  (NaN), a negative value, and zero, all of which a plain HTML `min`
 *  attribute does not actually prevent from being typed. */
export function isValidTradeSize(size: number): boolean {
  return Number.isFinite(size) && size > 0;
}

/** The minimal shape of ec-core's PlacedOrder this needs: enough to tell a
 *  genuinely sent, uncrossed order (has a hash) from an order that was
 *  never sent because its size rounded to zero on the tick/lot grid before
 *  any chain call was made (placeLimit's own early return, no hash). */
export interface TradeOutcome {
  filled: number;
  hash?: string;
}

/**
 * Describes what a buy actually did, without conflating "sent, did not
 * cross" with "never sent at all". Both previously read as the same
 * "sent, no fill" message; the only difference visible to a careful reader
 * was whether a tx-hash link appeared underneath, which most people would
 * not think to check. `result.hash` is the reliable signal: it is present
 * only when a transaction actually reached the chain.
 */
export function describeTradeResult(outcome: "YES" | "NO", price: number, result: TradeOutcome): string {
  if (result.hash === undefined) {
    return `${outcome} not sent: size rounded to zero on this market's own tick/lot grid, nothing was submitted`;
  }
  if (result.filled > 0) {
    return `${outcome} filled ${result.filled.toFixed(3)} at ~${price.toFixed(3)}`;
  }
  return `${outcome} sent but did not cross at ~${price.toFixed(3)}, no fill (tx below)`;
}
