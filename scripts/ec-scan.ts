// Read-only pricing scan over live DreamDEX event-contract markets. For each
// active binary market: prints symbol, underlying, strike (opening price),
// time to expiry, YES best bid/ask, model-fair YES probability, and the edge
// on each side, ranked by absolute edge. Sends no transactions and places no
// orders.
//
//   NETWORK=testnet npx tsx scripts/ec-scan.ts

import { config as dotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PriceSample } from "@dreamdex-bot-kit/ec-pricing";

dotenv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env") });

const { createExchange, loadConfig, shutdown, resolveVenue, activeMarkets, outcomeSymbols } =
  await import("@dreamdex-bot-kit/ec-core");
const { getOpeningPrices } = await import("@somnia-chain/markets-sdk");
const { fairYesProbability, estimateRealizedVol } = await import("@dreamdex-bot-kit/ec-pricing");

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/**
 * The oracle's OracleAnswer.numericValue has no documented decimal scale in
 * this SDK version (flagged in NOTES.md's SDK feedback log). We infer it at
 * runtime by comparing the raw opening-price answer against a fresh
 * fetchPrice() reading for the same asset and rounding the ratio to the
 * nearest power of ten, rather than hardcoding a scale that could silently
 * be wrong for a different asset or a future oracle redeploy.
 */
function inferScale(rawNumericValue: number, referencePrice: number): number {
  const ratio = referencePrice / rawNumericValue;
  const exponent = Math.round(Math.log10(ratio));
  return 10 ** exponent;
}

interface Row {
  symbol: string;
  asset: string;
  openingPrice: number;
  spot: number;
  ttlMinutes: number;
  yesBid: number | undefined;
  yesAsk: number | undefined;
  modelYes: number;
  edgeYes: number | null;
  edgeNo: number | null;
  volAnnualized: number | null;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const ctx = createExchange({ withSigner: false });
  await ctx.exchange.loadMarkets(true);
  await resolveVenue(ctx);

  const markets = await activeMarkets(ctx, { max: cfg.maxMarkets ?? 25 });
  console.log(`network : ${cfg.network} (chain ${cfg.chainId})`);
  console.log(`scanning ${markets.length} active market(s)\n`);

  const ids = markets
    .map((m) => (m.info.marketType === "BINARY" ? m.info.marketId : null))
    .filter((id): id is string => id !== null);
  const openings = await getOpeningPrices(ids, cfg.indexerUrl);

  // Cache one price-history fetch and one fetchPrice per asset - several
  // markets on the same underlying share both.
  const priceCache = new Map<string, number>();
  const volCache = new Map<string, number | null>();

  const rows: Row[] = [];
  const skipped: { symbol: string; reason: string }[] = [];

  for (const m of markets) {
    if (m.info.marketType !== "BINARY") continue;
    const { asset, marketId, expiry } = m.info;
    if (!asset) {
      skipped.push({ symbol: m.symbol, reason: "no `asset` field on market row" });
      continue;
    }

    const rawOpening = openings[marketId.toLowerCase()];
    if (rawOpening === null || rawOpening === undefined) {
      skipped.push({ symbol: m.symbol, reason: "no opening-price oracle answer yet (reference question unresolved)" });
      continue;
    }

    let spot = priceCache.get(asset);
    if (spot === undefined) {
      const price = await ctx.exchange.fetchPrice(asset);
      if (!price) {
        skipped.push({ symbol: m.symbol, reason: `fetchPrice(${asset}) returned null` });
        continue;
      }
      spot = price.price;
      priceCache.set(asset, spot);
    }

    const scale = inferScale(Number(rawOpening), spot);
    const openingPrice = Number(rawOpening) * scale;

    const nowSec = Date.now() / 1000;
    const ttlSec = Number(expiry) - nowSec;
    const ttlMinutes = ttlSec / 60;
    if (ttlSec <= 0) {
      skipped.push({ symbol: m.symbol, reason: "expiry already passed (stale row)" });
      continue;
    }

    let vol = volCache.get(asset);
    if (vol === undefined) {
      const ohlcv = await ctx.exchange.fetchPriceOHLCV(asset, "1m", Date.now() - 2 * 60 * 60 * 1000, 500);
      const samples: PriceSample[] = ohlcv.map(([ms, , , , close]) => ({ price: close, timestampMs: ms }));
      vol = estimateRealizedVol(samples);
      volCache.set(asset, vol);
    }
    // Fallback prior when the realized-vol estimator declines to answer (too
    // few candles - common for these short windows, see realizedVol.ts's
    // documented limitations). This is a coarse placeholder, not a
    // calibrated volatility surface; it exists so the scan still prints a
    // number instead of crashing, not because it is trustworthy on its own.
    const FALLBACK_ANNUAL_VOL = 0.6;
    const volForPricing = vol ?? FALLBACK_ANNUAL_VOL;

    const timeToExpiryYears = ttlSec / (MS_PER_YEAR / 1000);
    const modelYes = fairYesProbability({ spot, openingPrice, timeToExpiryYears, volatility: volForPricing });

    const { yes } = outcomeSymbols(m);
    const book = await ctx.exchange.fetchOrderBook(yes, 1);
    const yesBid = book.bids[0]?.[0];
    const yesAsk = book.asks[0]?.[0];

    const edgeYes = yesBid !== undefined && yesAsk !== undefined ? modelYes - (yesBid + yesAsk) / 2 : null;
    const edgeNo = edgeYes !== null ? -edgeYes : null;

    rows.push({
      symbol: m.symbol,
      asset,
      openingPrice,
      spot,
      ttlMinutes,
      yesBid,
      yesAsk,
      modelYes,
      edgeYes,
      edgeNo,
      volAnnualized: vol,
    });
  }

  rows.sort((a, b) => Math.abs(b.edgeYes ?? 0) - Math.abs(a.edgeYes ?? 0));

  const fmt = (n: number | undefined | null, digits = 4) => (n === undefined || n === null ? "-" : n.toFixed(digits));

  console.log(
    [
      "symbol".padEnd(30),
      "asset".padEnd(6),
      "ttl(m)".padStart(7),
      "openingPx".padStart(11),
      "spot".padStart(11),
      "vol(ann)".padStart(9),
      "yesBid".padStart(7),
      "yesAsk".padStart(7),
      "modelYes".padStart(9),
      "edgeYes".padStart(8),
      "edgeNo".padStart(8),
    ].join(" | "),
  );

  for (const r of rows) {
    console.log(
      [
        r.symbol.padEnd(30),
        r.asset.padEnd(6),
        r.ttlMinutes.toFixed(1).padStart(7),
        r.openingPrice.toFixed(2).padStart(11),
        r.spot.toFixed(2).padStart(11),
        fmt(r.volAnnualized, 2).padStart(9),
        fmt(r.yesBid, 3).padStart(7),
        fmt(r.yesAsk, 3).padStart(7),
        fmt(r.modelYes, 4).padStart(9),
        fmt(r.edgeYes, 4).padStart(8),
        fmt(r.edgeNo, 4).padStart(8),
      ].join(" | "),
    );
  }

  if (skipped.length > 0) {
    console.log(`\nskipped ${skipped.length} market(s):`);
    for (const s of skipped) console.log(`  ${s.symbol}: ${s.reason}`);
  }

  await shutdown(ctx);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
