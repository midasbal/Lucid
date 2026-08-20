// Lucid's maker, v1: a single-capital, fair-value market maker on one binary
// event-contract market. Off-chain quoting brain only; the on-chain reactive
// OrderFilled handler is a later chunk, not this one. This process polls,
// decides, places, and cancels, entirely off-chain, using our own capital
// (DELEGATION-PROBE.md found placeBinaryOrderFor non-functional, so no
// operator delegation here).
//
//   DRY_RUN=true npm start -w lucid-maker
//   DRY_RUN=false npm start -w lucid-maker   (funded PRIVATE_KEY required)

import "dotenv/config";
import {
  createExchange,
  loadConfig,
  resolveVenue,
  activeMarkets,
  marketOnchain,
  outcomeSymbols,
  netPosition,
  sellableSize,
  seedInventory,
  placeLimit,
  MARKET_STATUS,
  shutdown,
  type EcContext,
} from "@dreamdex-bot-kit/ec-core";
import { getOpeningPrices, isBinaryMarket, type UnifiedMarket } from "@somnia-chain/markets-sdk";
import { fairYesProbability, estimateRealizedVol, type PriceSample } from "@dreamdex-bot-kit/ec-pricing";
import {
  planQuotes,
  shouldRequote,
  shouldPinRisk,
  applyFill,
  markToModelPnl,
  INITIAL_PNL_STATE,
  type MakerConfig,
  type PnlState,
} from "./maker.js";

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const DRY_RUN = (process.env.DRY_RUN ?? "true").toLowerCase() !== "false";
const REFRESH_MS = envNum("MM_REFRESH_MS", 10_000);
const RUN_SECONDS = envNum("MM_RUN_SECONDS", 0); // 0 = run until stopped

const CFG: MakerConfig = {
  halfSpread: envNum("MM_HALF_SPREAD", 0.008),
  quoteNotional: envNum("MM_QUOTE_NOTIONAL", 2),
  maxPosition: envNum("MM_MAX_POSITION", 8),
  maxNotional: envNum("MM_MAX_NOTIONAL", 6),
  skewPerUnit: envNum("MM_SKEW_PER_UNIT", 0.02),
  requoteThreshold: envNum("MM_REQUOTE_THRESHOLD", 0.006),
};

const MIN_TTL_SEC = envNum("MM_MIN_TTL_SEC", 150);
const MIN_MARKET_TTL_MIN = envNum("MM_MIN_MARKET_TTL_MIN", 10);
const MAX_MARKET_TTL_MIN = envNum("MM_MAX_MARKET_TTL_MIN", 40);
const FALLBACK_VOL = envNum("MM_FALLBACK_VOL", 0.6);

const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);

function inferScale(rawNumericValue: number, referencePrice: number): number {
  const ratio = referencePrice / rawNumericValue;
  const exponent = Math.round(Math.log10(ratio));
  return 10 ** exponent;
}

interface RestingQuote {
  orderId: bigint;
  price: number;
}

interface OrderFilledLog {
  transactionHash: `0x${string}`;
  blockNumber: bigint;
  args: { takerOrderId?: bigint; makerOrderId?: bigint; quantityFilled?: bigint; fillPrice?: bigint };
}

const ORDER_FILLED_ABI = [
  {
    type: "event",
    name: "OrderFilled",
    inputs: [
      { name: "takerOrderId", type: "uint128", indexed: true },
      { name: "makerOrderId", type: "uint128", indexed: true },
      { name: "quantityFilled", type: "uint256", indexed: false },
      { name: "takerRemainingQuantity", type: "uint256", indexed: false },
      { name: "makerRemainingQuantity", type: "uint256", indexed: false },
      { name: "fillPrice", type: "uint256", indexed: false },
    ],
  },
] as const;

async function pickMarket(ctx: EcContext): Promise<UnifiedMarket> {
  const markets = await activeMarkets(ctx, { max: 1e6 });
  let best: { market: UnifiedMarket; ttlMin: number } | null = null;
  for (const m of markets) {
    if (m.info.marketType !== "BINARY") continue;
    const onchain = await marketOnchain(ctx, m);
    if (!onchain || onchain.status !== MARKET_STATUS.Trading) continue;
    const ttlMin = (Number(onchain.expiry) - Date.now() / 1000) / 60;
    if (ttlMin < MIN_MARKET_TTL_MIN || ttlMin > MAX_MARKET_TTL_MIN) continue;
    if (!best || ttlMin < best.ttlMin) best = { market: m, ttlMin };
  }
  if (!best) throw new Error(`no live Trading market with ${MIN_MARKET_TTL_MIN}-${MAX_MARKET_TTL_MIN}min ttl found`);
  log(`target market: ${best.market.symbol}, ttl ${best.ttlMin.toFixed(1)}min`);
  return best.market;
}

async function computeFairYes(ctx: EcContext, market: UnifiedMarket, expiry: bigint): Promise<number> {
  if (!isBinaryMarket(market.info)) throw new Error("not binary");
  const asset = market.info.asset;
  if (!asset) throw new Error("market has no asset field");

  const cfg = loadConfig();
  const marketId = market.info.marketId;
  const openings = await getOpeningPrices([marketId], cfg.indexerUrl);
  const rawOpening = openings[marketId.toLowerCase()];
  if (rawOpening === null || rawOpening === undefined) throw new Error("no opening price answer yet");

  const price = await ctx.exchange.fetchPrice(asset);
  if (!price) throw new Error(`fetchPrice(${asset}) returned null`);
  const spot = price.price;
  const scale = inferScale(Number(rawOpening), spot);
  const openingPrice = Number(rawOpening) * scale;

  const ohlcv = await ctx.exchange.fetchPriceOHLCV(asset, "1m", Date.now() - 2 * 60 * 60 * 1000, 500);
  const samples: PriceSample[] = ohlcv.map(([ms, , , , close]) => ({ price: close, timestampMs: ms }));
  const vol = estimateRealizedVol(samples) ?? FALLBACK_VOL;

  const ttlSec = Number(expiry) - Date.now() / 1000;
  const timeToExpiryYears = Math.max(ttlSec, 1) / (MS_PER_YEAR / 1000);

  return fairYesProbability({ spot, openingPrice, timeToExpiryYears, volatility: vol });
}

async function main(): Promise<void> {
  const ctx = createExchange({ withSigner: !DRY_RUN });
  await ctx.exchange.loadMarkets(true);
  await resolveVenue(ctx);

  log(`lucid-maker up · dryRun=${DRY_RUN} · halfSpread=${CFG.halfSpread} quoteNotional=${CFG.quoteNotional}` + ` maxPosition=${CFG.maxPosition} maxNotional=${CFG.maxNotional} skewPerUnit=${CFG.skewPerUnit}` + ` requoteThreshold=${CFG.requoteThreshold} minTtlSec=${MIN_TTL_SEC}`);

  const market = await pickMarket(ctx);
  const { yes } = outcomeSymbols(market);

  let seeded = false;
  let resting: { bid?: RestingQuote; ask?: RestingQuote } = {};
  let pnl: PnlState = INITIAL_PNL_STATE;
  let lastFillCheckBlock: bigint | null = null;
  let pinned = false;

  // Every order id this session has ever placed, with the side/price it was
  // sent at, so a fill landing in the race window between "check fills" and
  // "cancel and replace" within one cycle is still attributed on the next
  // pass instead of silently lost when resting.bid/resting.ask gets
  // overwritten with the replacement order's id.
  const allOrders = new Map<bigint, { side: "bid" | "ask"; price: number }>();
  const processedFillKeys = new Set<string>();

  let stop = false;
  const requestStop = () => (stop = true);
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);

  const publicClient = ctx.exchange.client.getViemClient();
  const startedAt = Date.now();

  async function checkFills(onchain: Awaited<ReturnType<typeof marketOnchain>>): Promise<void> {
    if (!onchain || DRY_RUN) return;
    if (allOrders.size === 0) return;

    const latest = await publicClient.getBlockNumber();
    const from = lastFillCheckBlock ?? (latest - 50n > 0n ? latest - 50n : 0n);
    lastFillCheckBlock = latest + 1n;

    let logs: OrderFilledLog[] = [];
    let cursor = from;
    while (cursor <= latest) {
      const to = cursor + 900n < latest ? cursor + 900n : latest;
      const chunk = await publicClient.getContractEvents({ address: onchain.pool, abi: ORDER_FILLED_ABI, eventName: "OrderFilled", fromBlock: cursor, toBlock: to });
      logs = logs.concat(chunk as unknown as OrderFilledLog[]);
      cursor = to + 1n;
    }

    for (const l of logs) {
      const makerId = l.args.makerOrderId;
      if (makerId === undefined) continue;
      const tracked = allOrders.get(makerId);
      if (!tracked) continue; // not one of ours, or an order from before this session

      const key = `${l.transactionHash}:${makerId}`;
      if (processedFillKeys.has(key)) continue;
      processedFillKeys.add(key);

      const size = Number(l.args.quantityFilled ?? 0n) / 1e6;
      const side = tracked.side === "bid" ? "buy" : "sell";
      pnl = applyFill(pnl, { side, price: tracked.price, size });
      log(`FILL: ${tracked.side} orderId=${makerId} size=${size} tx=${l.transactionHash}`);

      // The order that just filled can no longer be cancelled; drop it from
      // resting so the next cancel pass does not waste a call (or worse,
      // read a revert as a signal something is wrong) on an order that is
      // simply gone.
      if (resting.bid?.orderId === makerId) resting.bid = undefined;
      if (resting.ask?.orderId === makerId) resting.ask = undefined;
    }
  }

  async function cancelResting(): Promise<void> {
    if (DRY_RUN) {
      resting = {};
      return;
    }
    for (const q of [resting.bid, resting.ask]) {
      if (!q) continue;
      try {
        const onchain = await marketOnchain(ctx, market);
        if (!onchain) continue;
        await ctx.exchange.trader.cancelOrder({ pool: onchain.pool, orderId: q.orderId });
      } catch (e) {
        log(`cancel ${q.orderId} failed: ${(e as Error).message}`);
      }
    }
    resting = {};
  }

  async function loop(): Promise<void> {
    const onchain = await marketOnchain(ctx, market);
    if (!onchain) {
      log("market snapshot unavailable this cycle, skipping");
      return;
    }
    if (onchain.status !== MARKET_STATUS.Trading) {
      log(`market left Trading (status ${onchain.status}), pinning risk and stopping`);
      await cancelResting();
      stop = true;
      return;
    }

    const ttlSec = Number(onchain.expiry) - Date.now() / 1000;
    if (shouldPinRisk(ttlSec, MIN_TTL_SEC)) {
      if (!pinned) {
        log(`ttl ${ttlSec.toFixed(0)}s under floor ${MIN_TTL_SEC}s, pinning risk: cancelling resting quotes, no new quotes`);
        await cancelResting();
        pinned = true;
      }
      return;
    }
    pinned = false;

    if (!seeded && !DRY_RUN) {
      await seedInventory(ctx, market, onchain);
      seeded = true;
    }

    const book = await ctx.exchange.fetchOrderBook(yes, 3);
    const bestBid = book.bids[0]?.[0];
    const bestAsk = book.asks[0]?.[0];
    const spread = bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : undefined;

    const fairYes = await computeFairYes(ctx, market, onchain.expiry);
    const net = DRY_RUN ? pnl.position : await netPosition(ctx, onchain);
    const plan = planQuotes({ fairYes, netPosition: net, cfg: CFG });

    await checkFills(onchain);

    const current = { bidPrice: resting.bid?.price, askPrice: resting.ask?.price };
    const needsRequote = shouldRequote(current, plan, CFG.requoteThreshold);

    const bidImproves = plan.bid.active && bestBid !== undefined && plan.bid.price > bestBid;
    const askImproves = plan.ask.active && bestAsk !== undefined && plan.ask.price < bestAsk;
    const ourSpread = plan.bid.active && plan.ask.active ? plan.ask.price - plan.bid.price : undefined;

    log(
      `book: bid=${bestBid?.toFixed(4) ?? "-"} ask=${bestAsk?.toFixed(4) ?? "-"} spread=${spread?.toFixed(4) ?? "-"}` +
        ` | fair=${fairYes.toFixed(4)} skewedFair=${plan.skewedFair.toFixed(4)}` +
        ` | ours: bid=${plan.bid.active ? `${plan.bid.size.toFixed(3)}@${plan.bid.price.toFixed(4)}${bidImproves ? " (improves top)" : ""}` : `skip(${plan.bid.skipReason})`}` +
        ` ask=${plan.ask.active ? `${plan.ask.size.toFixed(3)}@${plan.ask.price.toFixed(4)}${askImproves ? " (improves top)" : ""}` : `skip(${plan.ask.skipReason})`}` +
        ` ourSpread=${ourSpread?.toFixed(4) ?? "-"}` +
        ` | inventory=${net.toFixed(3)} pnl=${markToModelPnl(pnl, fairYes).toFixed(4)}` +
        ` | requote=${needsRequote}`,
    );

    if (!needsRequote) return;

    if (DRY_RUN) {
      resting = {
        bid: plan.bid.active ? { orderId: 0n, price: plan.bid.price } : undefined,
        ask: plan.ask.active ? { orderId: 0n, price: plan.ask.price } : undefined,
      };
      return;
    }

    await cancelResting();

    if (plan.bid.active && plan.bid.size > 0) {
      const res = await placeLimit(ctx, { market, onchain, outcome: "YES", side: "buy", price: plan.bid.price, size: plan.bid.size, type: "post-only" });
      if (res.orderId !== undefined) {
        resting.bid = { orderId: res.orderId, price: res.price };
        allOrders.set(res.orderId, { side: "bid", price: res.price });
        log(`placed bid: ${res.size}@${res.price} orderId=${res.orderId} hash=${res.hash}`);
      }
    }
    if (plan.ask.active && plan.ask.size > 0) {
      // Cap to what we can actually sell. You can only sell an outcome you
      // hold (mint-a-pair, no naked short), and MM_INVENTORY has nothing to
      // do with the quote sizing above, so the two can disagree once enough
      // asks have filled. Sending an order the pool will reject is a wasted
      // transaction; asking first is not.
      const capped = await sellableSize(ctx, onchain, "YES", plan.ask.size);
      if (capped <= 0) {
        log(`ask skipped: no sellable YES inventory left (wanted ${plan.ask.size.toFixed(3)})`);
      } else {
        const res = await placeLimit(ctx, { market, onchain, outcome: "YES", side: "sell", price: plan.ask.price, size: capped, type: "post-only" });
        if (res.orderId !== undefined) {
          resting.ask = { orderId: res.orderId, price: res.price };
          allOrders.set(res.orderId, { side: "ask", price: res.price });
          log(`placed ask: ${res.size}@${res.price} orderId=${res.orderId} hash=${res.hash}${capped < plan.ask.size ? ` (capped from ${plan.ask.size.toFixed(3)} by inventory)` : ""}`);
        }
      }
    }
  }

  while (!stop) {
    try {
      await loop();
    } catch (e) {
      log(`cycle error: ${(e as Error).message}`);
    }
    if (stop) break;
    if (RUN_SECONDS > 0 && (Date.now() - startedAt) / 1000 >= RUN_SECONDS) {
      log(`MM_RUN_SECONDS=${RUN_SECONDS} elapsed, stopping`);
      break;
    }
    for (let t = 0; t < REFRESH_MS && !stop; t += 500) await new Promise((r) => setTimeout(r, Math.min(500, REFRESH_MS - t)));
  }

  log("shutting down, cancelling all resting orders");
  await cancelResting();
  const finalOnchain = await marketOnchain(ctx, market);
  const finalFair = finalOnchain ? await computeFairYes(ctx, market, finalOnchain.expiry).catch(() => 0.5) : 0.5;
  // Verified on-chain position, not the internal pnl ledger: a missed-fill
  // race (documented in MAKER.md) can desync pnl.position from reality, and
  // the shutdown summary should report the true state, not a number that
  // might be wrong. Internal pnl.cash still feeds the mark-to-model estimate
  // since there is no on-chain "cash spent" figure to read directly.
  const verifiedNet = !DRY_RUN && finalOnchain ? await netPosition(ctx, finalOnchain) : pnl.position;
  log(`final inventory (verified on-chain)=${verifiedNet.toFixed(3)} · internal ledger position=${pnl.position.toFixed(3)}`);
  log(`final pnl (mark to model, from internal cash ledger)=${markToModelPnl(pnl, finalFair).toFixed(4)}`);

  await shutdown(ctx);
  log("lucid-maker stopped");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
