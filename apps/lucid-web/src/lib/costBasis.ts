import type { Fill } from "./indexer";

export interface OutcomeCostBasis {
  sharesBought: number;
  cashSpent: number;
  sharesSold: number;
  cashReceived: number;
  /** Weighted average entry price across every buy fill, undefined if never bought. */
  avgEntryPrice: number | undefined;
}

export interface CostBasis {
  yes: OutcomeCostBasis;
  no: OutcomeCostBasis;
}

const EMPTY: OutcomeCostBasis = { sharesBought: 0, cashSpent: 0, sharesSold: 0, cashReceived: 0, avgEntryPrice: undefined };

/**
 * Cost basis derived from this account's own fill history, maker and taker
 * fills alike. Neither lucid-core nor the SDK expose this, a trade's cost
 * basis is not chain state, it is a function of what this specific account
 * actually paid across every fill it was a counterparty to. A simple
 * weighted-average entry price across buy fills, no FIFO lot tracking, good
 * enough for a position summary, not a tax report.
 */
export function computeCostBasis(fills: Fill[], account: string, decimals: number): CostBasis {
  const one = 10 ** decimals;
  const acc = account.toLowerCase();
  let yes = { ...EMPTY };
  let no = { ...EMPTY };

  for (const f of fills) {
    const isMaker = f.maker.toLowerCase() === acc;
    const isTaker = f.taker.toLowerCase() === acc;
    if (!isMaker && !isTaker) continue;
    // A fill can match both if the same account was maker and taker
    // (self-trade); apply both legs independently.
    const sides: string[] = [];
    if (isMaker) sides.push(f.makerSide);
    if (isTaker) sides.push(f.takerSide);

    const quantity = Number(f.quantity) / one;
    const quoteQuantity = Number(f.quoteQuantity) / one;

    for (const side of sides) {
      const isYes = side.endsWith("_YES");
      const isBuy = side.startsWith("BUY");
      const bucket = isYes ? yes : no;
      const updated = isBuy
        ? { ...bucket, sharesBought: bucket.sharesBought + quantity, cashSpent: bucket.cashSpent + quoteQuantity }
        : { ...bucket, sharesSold: bucket.sharesSold + quantity, cashReceived: bucket.cashReceived + quoteQuantity };
      if (isYes) yes = updated;
      else no = updated;
    }
  }

  yes.avgEntryPrice = yes.sharesBought > 0 ? yes.cashSpent / yes.sharesBought : undefined;
  no.avgEntryPrice = no.sharesBought > 0 ? no.cashSpent / no.sharesBought : undefined;

  return { yes, no };
}
