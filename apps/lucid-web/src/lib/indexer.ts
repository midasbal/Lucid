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
