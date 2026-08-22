// Direct GraphQL reads against the SDK's own indexer, the exact query
// confirmed live in DATA-RECON.md. This is deliberately a plain fetch, not
// routed through lucid-core, because the point of the chart is to prove the
// indexer's OHLCV data renders straight from the browser, independent of
// anything the SDK itself wraps.

export interface Candle {
  bucketStart: string;
  intervalSeconds: number;
  openPrice: string;
  high: string;
  low: string;
  closePrice: string;
  baseVolume: string;
  quoteVolume: string;
  tradeCount: number;
}

export async function fetchCandles(indexerUrl: string, marketId: string, intervalSeconds: number): Promise<Candle[]> {
  const query = `
    query Candles($marketId: String!, $interval: Int!) {
      Candle(
        where: { market_id: { _eq: $marketId }, intervalSeconds: { _eq: $interval } }
        order_by: { bucketStart: asc }
      ) {
        bucketStart intervalSeconds openPrice high low closePrice baseVolume quoteVolume tradeCount
      }
    }
  `;
  const res = await fetch(indexerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { marketId, interval: intervalSeconds } }),
  });
  if (!res.ok) throw new Error(`indexer request failed: HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { Candle: Candle[] }; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(`indexer query failed: ${json.errors[0]!.message}`);
  return json.data?.Candle ?? [];
}

export interface Fill {
  id: string;
  timestamp: string;
  fillPrice: string;
  quantity: string;
  quoteQuantity: string;
  maker: string;
  taker: string;
  makerSide: string;
  takerSide: string;
}

/**
 * Every fill this account touched on this market, as maker or taker, per
 * DATA-RECON.md's confirmed Fill query. Used to derive cost basis: lucid-core
 * and the SDK have no such field themselves, this account's own trade
 * history is the only source for it.
 */
export async function fetchAccountFills(indexerUrl: string, marketId: string, account: string): Promise<Fill[]> {
  const query = `
    query AccountFills($marketId: String!, $account: String!) {
      Fill(
        where: { market_id: { _eq: $marketId }, _or: [{ maker: { _eq: $account } }, { taker: { _eq: $account } }] }
        order_by: { timestamp: asc }
      ) {
        id timestamp fillPrice quantity quoteQuantity maker taker makerSide takerSide
      }
    }
  `;
  const res = await fetch(indexerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { marketId, account: account.toLowerCase() } }),
  });
  if (!res.ok) throw new Error(`indexer request failed: HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { Fill: Fill[] }; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(`indexer query failed: ${json.errors[0]!.message}`);
  return json.data?.Fill ?? [];
}

export interface OpenBalanceRow {
  marketId: string;
  outcomeIndex: number;
  balance: string;
  market: { asset: string; question: string; finalized: boolean; voided: boolean; winningOutcome: number; expiry: string };
}

/**
 * Every (market, outcome) this account currently holds a nonzero balance on,
 * across every market it has ever touched, live and finalized alike, per
 * OutcomeBalance's confirmed shape in DATA-RECON.md. This is the discovery
 * step the portfolio view needs and lucid-core has no equivalent for: its
 * own market resolution (listLiveMarkets / resolveMarket) only covers
 * currently active markets, not ones the account still holds an unredeemed
 * balance on after they finalized.
 */
export async function fetchOpenBalances(indexerUrl: string, account: string): Promise<OpenBalanceRow[]> {
  const query = `
    query OpenBalances($account: String!) {
      OutcomeBalance(where: { account: { _eq: $account }, balance: { _gt: "0" } }) {
        market_id
        outcomeIndex
        balance
        market { asset question finalized voided winningOutcome expiry }
      }
    }
  `;
  const res = await fetch(indexerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { account: account.toLowerCase() } }),
  });
  if (!res.ok) throw new Error(`indexer request failed: HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: { OutcomeBalance: Array<{ market_id: string; outcomeIndex: number; balance: string; market: OpenBalanceRow["market"] }> };
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length) throw new Error(`indexer query failed: ${json.errors[0]!.message}`);
  return (json.data?.OutcomeBalance ?? []).map((r) => ({ marketId: r.market_id, outcomeIndex: r.outcomeIndex, balance: r.balance, market: r.market }));
}

export interface RedemptionRow {
  id: string;
  marketId: string;
  outcomeIdx: number;
  amountBurned: string;
  collateralOut: string;
  timestamp: string;
  txHash: string;
  market: { asset: string; question: string; voided: boolean; winningOutcome: number };
}

/** Every redemption this account has made, any market, the settled, real
 *  half of the portfolio view: DATA-RECON.md's confirmed RedemptionRecord
 *  query, extended with the market's own voided/winningOutcome so a
 *  won/lost/voided label does not need a second lookup per row.
 *
 *  Filters on holder OR to, not holder alone. Found live building this:
 *  redeeming through the plain self-redeem path (BinaryMarketsModule.redeem,
 *  not redeemFor) recorded RedemptionRecord.holder as the module's own
 *  address, not the position owner's, on every one of four real redemptions
 *  this session made to seed this view's own test data; `to`, the actual
 *  payout recipient, was correct every time. Other accounts' own
 *  self-redeems seen in the same table had holder = to = their own address,
 *  so this is not universal, just not safe to rely on alone. */
export async function fetchRedemptions(indexerUrl: string, account: string): Promise<RedemptionRow[]> {
  const query = `
    query AccountRedemptions($account: String!) {
      RedemptionRecord(where: { _or: [{ holder: { _eq: $account } }, { to: { _eq: $account } }] }, order_by: { timestamp: desc }) {
        id
        market_id
        outcomeIdx
        amountBurned
        collateralOut
        timestamp
        txHash
        market { asset question voided winningOutcome }
      }
    }
  `;
  const res = await fetch(indexerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { account: account.toLowerCase() } }),
  });
  if (!res.ok) throw new Error(`indexer request failed: HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: {
      RedemptionRecord: Array<{
        id: string;
        market_id: string;
        outcomeIdx: number;
        amountBurned: string;
        collateralOut: string;
        timestamp: string;
        txHash: string;
        market: RedemptionRow["market"];
      }>;
    };
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length) throw new Error(`indexer query failed: ${json.errors[0]!.message}`);
  return (json.data?.RedemptionRecord ?? []).map((r) => ({
    id: r.id,
    marketId: r.market_id,
    outcomeIdx: r.outcomeIdx,
    amountBurned: r.amountBurned,
    collateralOut: r.collateralOut,
    timestamp: r.timestamp,
    txHash: r.txHash,
    market: r.market,
  }));
}
