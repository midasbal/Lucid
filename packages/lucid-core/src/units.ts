// Raw-unit / human-unit conversion, the one place this project's own
// FINDINGS.md audit asked for it to live: the same Number(raw)/10**decimals
// and BigInt(Math.round(human*10**decimals)) expressions were repeated ad
// hoc across several call sites with no shared, documented safe range.
//
// Safe range: both directions go through a plain JS `number`, which only
// represents integers exactly up to 2^53 - 1 (Number.MAX_SAFE_INTEGER).
// Every real amount in this app, tUSDC collateral at 6 decimals, ordinary
// trade and position sizes, is many orders of magnitude below that boundary,
// so toHuman/toRaw are exact for every realistic value here. The boundary
// is stated explicitly so it stays an informed assumption, not a silent
// one: do not reuse these for an 18-decimal token or a raw amount anywhere
// near 2^53 without re-deriving the safety margin.
//
// For anything that gets embedded in a signed, on-chain commitment (an
// order size, a redeem amount), prefer reading the raw BigInt directly from
// chain and passing it straight through instead of reconstructing it via
// toRaw from a display value that already passed through toHuman once;
// that avoids the round trip entirely rather than merely keeping it safe.

/** Raw integer units (as returned by the chain/SDK) to a human-scale number. */
export function toHuman(raw: bigint | string, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/** Human-scale number to raw integer units, rounding to the nearest whole
 *  raw unit. Only reach for this when there is no live raw balance to read
 *  directly; a fresh on-chain read is always the safer source for an
 *  amount that will be signed or sent. */
export function toRaw(human: number, decimals: number): bigint {
  return BigInt(Math.round(human * 10 ** decimals));
}
