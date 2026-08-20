// Lucid's maker, v2: multi-market, continuous, fair-value market making on
// live Shannon testnet. Built on packages/lucid-core for every market read,
// pricing call, and order write; no market/pricing/trading logic is
// reimplemented here, only the quoting decisions, the trend guard, and the
// cross-market capital sharing that v1 never needed.
//
//   DRY_RUN=true npm start -w lucid-maker-v2
//   DRY_RUN=false npm start -w lucid-maker-v2   (funded PRIVATE_KEY required)

import "dotenv/config";
import { MARKET_STATUS, sellableSize, seedInventory, shutdown, type EcContext } from "@dreamdex-bot-kit/ec-core";
import type { MarketOnchain, UnifiedMarket } from "@somnia-chain/markets-sdk";
import {
  createLucidContext,
  createReadOnlyContext,
  listLiveMarkets,
  resolveMarket,
  getFairValueWithBook,
  getNetPosition,
  submitOrder,
  cancelOrder,
  type LucidContext,
} from "@dreamdex-bot-kit/lucid-core";
import { applyFill, markToModelPnl, planQuotes, scaledHalfSpread, shouldPinRisk, shouldRequote, INITIAL_PNL_STATE, type PnlState } from "./quoting.js";
import { computeTrend, guardAction, pruneSamples, type SpotSample } from "./trendGuard.js";
import { effectiveMarketNotionalCap, globalExposure, marketNotional, type PortfolioConfig } from "./portfolio.js";

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const DRY_RUN = (process.env.DRY_RUN ?? "true").toLowerCase() !== "false";
const REFRESH_MS = envNum("MM_REFRESH_MS", 15_000);
const RUN_SECONDS = envNum("MM_RUN_SECONDS", 0); // 0 = run until stopped; a bound is a test convenience, not the primary mode

const MAX_MARKETS = envNum("MM_MAX_MARKETS", 3);
const MIN_MARKET_TTL_MIN = envNum("MM_MIN_MARKET_TTL_MIN", 10);
const MAX_MARKET_TTL_MIN = envNum("MM_MAX_MARKET_TTL_MIN", 40);
const MIN_TTL_SEC = envNum("MM_MIN_TTL_SEC", 150);

const QUOTE_NOTIONAL = envNum("MM_QUOTE_NOTIONAL", 2);
const PER_MARKET_MAX_POSITION = envNum("MM_PER_MARKET_MAX_POSITION", 8);
const PORTFOLIO_CFG: PortfolioConfig = {
  globalMaxNotional: envNum("MM_GLOBAL_MAX_NOTIONAL", 12),
  perMarketMaxNotional: envNum("MM_PER_MARKET_MAX_NOTIONAL", 6),
  perMarketMaxPosition: PER_MARKET_MAX_POSITION,
};
const SKEW_PER_UNIT = envNum("MM_SKEW_PER_UNIT", 0.02);
const REQUOTE_THRESHOLD = envNum("MM_REQUOTE_THRESHOLD", 0.006);

const VOL_SPREAD_CFG = {
  baseHalfSpread: envNum("MM_BASE_HALF_SPREAD", 0.006),
  volMultiplier: envNum("MM_VOL_SPREAD_MULTIPLIER", 0.01),
  minHalfSpread: envNum("MM_MIN_HALF_SPREAD", 0.004),
  maxHalfSpread: envNum("MM_MAX_HALF_SPREAD", 0.05),
};

const TREND_CFG = {
  lookbackMs: envNum("MM_TREND_LOOKBACK_MS", 60_000),
  widenThresholdPct: envNum("MM_TREND_WIDEN_PCT", 0.003),
  pauseThresholdPct: envNum("MM_TREND_PAUSE_PCT", 0.006),
  widenMultiplier: envNum("MM_TREND_WIDEN_MULTIPLIER", 3),
};

const INVENTORY_PER_MARKET = envNum("MM_INVENTORY_PER_MARKET", 4);
const FALLBACK_VOL = envNum("MM_FALLBACK_VOL", 0.6);

const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);

interface RestingQuote {
  orderId: bigint;
  price: number;
}

interface MarketState {
  symbol: string;
  market: UnifiedMarket;
  onchain: MarketOnchain;
  asset: string;
  resting: { bid?: RestingQuote; ask?: RestingQuote };
  pnl: PnlState;
  seeded: boolean;
  allOrders: Map<bigint, { side: "bid" | "ask"; price: number }>;
  processedFillKeys: Set<string>;
  lastFillCheckBlock: bigint | null;
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

async function main(): Promise<void> {
  const privateKey = DRY_RUN ? undefined : (process.env.PRIVATE_KEY as `0x${string}` | undefined);
  if (!DRY_RUN && !privateKey) throw new Error("PRIVATE_KEY required for a live run (DRY_RUN=false)");
  const ctx: LucidContext = DRY_RUN ? createReadOnlyContext() : createLucidContext({ privateKey });
  await ctx.exchange.loadMarkets(true);

  log(
    `lucid-maker-v2 up · dryRun=${DRY_RUN} · maxMarkets=${MAX_MARKETS} · ttlWindow=${MIN_MARKET_TTL_MIN}-${MAX_MARKET_TTL_MIN}min · minTtlSec=${MIN_TTL_SEC}` +
      ` · quoteNotional=${QUOTE_NOTIONAL} · perMarketMaxPosition=${PER_MARKET_MAX_POSITION} · perMarketMaxNotional=${PORTFOLIO_CFG.perMarketMaxNotional}` +
      ` · globalMaxNotional=${PORTFOLIO_CFG.globalMaxNotional} · baseHalfSpread=${VOL_SPREAD_CFG.baseHalfSpread}`,
  );

  const active = new Map<string, MarketState>();
  const trendSamples = new Map<string, SpotSample[]>();
  let stop = false;
  const requestStop = () => (stop = true);
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);

  const publicClient = ctx.exchange.client.getViemClient();
  const startedAt = Date.now();

  async function cancelMarketResting(state: MarketState): Promise<void> {
    if (DRY_RUN) {
      state.resting = {};
      return;
    }
    for (const q of [state.resting.bid, state.resting.ask]) {
      if (!q) continue;
      try {
        await cancelOrder(ctx, state.onchain, q.orderId);
      } catch (e) {
        log(`${state.symbol}: cancel ${q.orderId} failed: ${(e as Error).message}`);
      }
    }
    state.resting = {};
  }

  async function cancelAllResting(): Promise<void> {
    for (const state of active.values()) await cancelMarketResting(state);
  }

  async function checkFills(state: MarketState): Promise<void> {
    if (DRY_RUN || state.allOrders.size === 0) return;

    const latest = await publicClient.getBlockNumber();
    const from = state.lastFillCheckBlock ?? (latest - 50n > 0n ? latest - 50n : 0n);
    state.lastFillCheckBlock = latest + 1n;

    let logs: OrderFilledLog[] = [];
    let cursor = from;
    while (cursor <= latest) {
      const to = cursor + 900n < latest ? cursor + 900n : latest;
      const chunk = await publicClient.getContractEvents({ address: state.onchain.pool, abi: ORDER_FILLED_ABI, eventName: "OrderFilled", fromBlock: cursor, toBlock: to });
      logs = logs.concat(chunk as unknown as OrderFilledLog[]);
      cursor = to + 1n;
    }

    for (const l of logs) {
      const makerId = l.args.makerOrderId;
      if (makerId === undefined) continue;
      const tracked = state.allOrders.get(makerId);
      if (!tracked) continue;

      const key = `${l.transactionHash}:${makerId}`;
      if (state.processedFillKeys.has(key)) continue;
      state.processedFillKeys.add(key);

      const size = Number(l.args.quantityFilled ?? 0n) / 10 ** state.onchain.decimals;
      const side = tracked.side === "bid" ? "buy" : "sell";
      state.pnl = applyFill(state.pnl, { side, price: tracked.price, size });
      log(`${state.symbol}: FILL ${tracked.side} orderId=${makerId} size=${size} tx=${l.transactionHash}`);

      if (state.resting.bid?.orderId === makerId) state.resting.bid = undefined;
      if (state.resting.ask?.orderId === makerId) state.resting.ask = undefined;
    }
  }

  async function rotate(): Promise<void> {
    const live = await listLiveMarkets(ctx);
    const inWindow = new Set(
      live.filter((m) => {
        const ttlMin = m.ttlSec / 60;
        return ttlMin >= MIN_MARKET_TTL_MIN && ttlMin <= MAX_MARKET_TTL_MIN;
      }).map((m) => m.symbol),
    );
    const stillTrading = new Set(live.map((m) => m.symbol));

    for (const [symbol, state] of [...active]) {
      const ttlSec = Number(state.onchain.expiry) - Date.now() / 1000;
      const pinned = shouldPinRisk(ttlSec, MIN_TTL_SEC);
      const delisted = !stillTrading.has(symbol);
      if (pinned || delisted) {
        await cancelMarketResting(state);
        active.delete(symbol);
        log(`dropped ${symbol}: ${delisted ? "left Trading" : `near-expiry pin (ttl ${ttlSec.toFixed(0)}s < ${MIN_TTL_SEC}s)`}, final inventory=${state.pnl.position.toFixed(3)} pnl(cash)=${state.pnl.cash.toFixed(4)}`);
      }
    }

    const openSlots = MAX_MARKETS - active.size;
    if (openSlots <= 0) return;

    const candidates = live.filter((m) => inWindow.has(m.symbol) && !active.has(m.symbol)).sort((a, b) => b.ttlSec - a.ttlSec);

    for (const c of candidates.slice(0, openSlots)) {
      const { market, onchain } = await resolveMarket(ctx, c.symbol);
      if (onchain.status !== MARKET_STATUS.Trading) continue;
      active.set(c.symbol, {
        symbol: c.symbol,
        market,
        onchain,
        asset: c.asset,
        resting: {},
        pnl: INITIAL_PNL_STATE,
        seeded: false,
        allOrders: new Map(),
        processedFillKeys: new Set(),
        lastFillCheckBlock: null,
      });
      log(`picked up ${c.symbol}: ttl ${(c.ttlSec / 60).toFixed(1)}min, quoting now`);
    }
  }

  // One market's own quote cycle: pricing already read, guard and portfolio
  // cap computed, plan built, fills checked, requote sent if needed. Runs
  // inside a per-market try/catch in cycle() below, so a placement error on
  // one market (a stale-price revert, a transient RPC failure) never blocks
  // the others in the same pass.
  type Reading = { fairYes: number; volatility: number; netPosition: number; bestBid?: number; bestAsk?: number; spot: number; tickSize: bigint; lotSize: bigint };

  async function quoteOneMarket(state: MarketState, reading: Reading, otherMarketsExposure: number, counters: { quotedCount: number; bothSidesCount: number; guardEngagedCount: number }): Promise<void> {
    const effectiveNotionalCap = effectiveMarketNotionalCap(PORTFOLIO_CFG, otherMarketsExposure);

    const samples = pruneSamples([...(trendSamples.get(state.asset) ?? []), { price: reading.spot, timestampMs: Date.now() }], TREND_CFG.lookbackMs, Date.now());
    trendSamples.set(state.asset, samples);
    const trend = computeTrend(samples, TREND_CFG);
    const guard = guardAction(trend, TREND_CFG);
    if (guard.pauseBid || guard.pauseAsk) {
      counters.guardEngagedCount++;
      log(`${state.symbol} (${state.asset}): TREND GUARD ${guard.reason}`);
    }

    const baseHalfSpread = scaledHalfSpread(VOL_SPREAD_CFG, reading.volatility);
    const bidHalfSpread = baseHalfSpread * guard.bidWidenMultiplier;
    const askHalfSpread = baseHalfSpread * guard.askWidenMultiplier;

    const plan = planQuotes({
      fairYes: reading.fairYes,
      netPosition: reading.netPosition,
      quoteNotional: QUOTE_NOTIONAL,
      maxPosition: PER_MARKET_MAX_POSITION,
      maxNotional: effectiveNotionalCap,
      skewPerUnit: SKEW_PER_UNIT,
      bidHalfSpread,
      askHalfSpread,
      pauseBid: guard.pauseBid,
      pauseAsk: guard.pauseAsk,
    });

    await checkFills(state);

    const current = { bidPrice: state.resting.bid?.price, askPrice: state.resting.ask?.price };
    const needsRequote = shouldRequote(current, plan, REQUOTE_THRESHOLD);

    const upCovered = plan.ask.active;
    const downCovered = plan.bid.active;
    counters.quotedCount++;
    if (upCovered && downCovered) counters.bothSidesCount++;

    log(
      `${state.symbol}: fair=${reading.fairYes.toFixed(4)} vol=${reading.volatility.toFixed(3)} book bid=${reading.bestBid?.toFixed(4) ?? "-"} ask=${reading.bestAsk?.toFixed(4) ?? "-"}` +
        ` | ours: bid(down-bettor)=${plan.bid.active ? `${plan.bid.size.toFixed(3)}@${plan.bid.price.toFixed(4)}` : `skip(${plan.bid.skipReason})`}` +
        ` ask(up-bettor)=${plan.ask.active ? `${plan.ask.size.toFixed(3)}@${plan.ask.price.toFixed(4)}` : `skip(${plan.ask.skipReason})`}` +
        ` | twoSided=${upCovered && downCovered} | inventory=${reading.netPosition.toFixed(3)} pnl=${markToModelPnl(state.pnl, reading.fairYes).toFixed(4)} notionalCap=${effectiveNotionalCap.toFixed(3)}` +
        ` | requote=${needsRequote}`,
    );

    if (!needsRequote) return;

    if (DRY_RUN) {
      state.resting = {
        bid: plan.bid.active ? { orderId: 0n, price: plan.bid.price } : undefined,
        ask: plan.ask.active ? { orderId: 0n, price: plan.ask.price } : undefined,
      };
      return;
    }

    // Real lot/tick from the pool this cycle (Pass A), not a config default:
    // a pool's real grid can differ from the global MM_LOT/MM_TICK env value,
    // and sending a size that does not conform to the real lot reverts on chain.
    const orderCtx = { ...ctx, config: { ...ctx.config, tick: reading.tickSize, lot: reading.lotSize } } as unknown as LucidContext;

    if (!state.seeded) {
      const seedCtx = { ...orderCtx, config: { ...orderCtx.config, inventory: INVENTORY_PER_MARKET } };
      await seedInventory(seedCtx as unknown as EcContext, state.market, state.onchain);
      state.seeded = true;
    }

    await cancelMarketResting(state);

    // post-only rejects on-chain if it would cross the live book (take
    // instead of rest). Model fair value can sit far enough from a thin or
    // stale book that a straddled quote crosses on one side; catching that
    // here up front avoids a doomed transaction, and isolating each side's
    // placement below means a genuinely crossing bid never also takes down
    // an otherwise-fine ask in the same cycle, or the reverse.
    const bidCrosses = plan.bid.active && reading.bestAsk !== undefined && plan.bid.price >= reading.bestAsk;
    const askCrosses = plan.ask.active && reading.bestBid !== undefined && plan.ask.price <= reading.bestBid;

    if (plan.bid.active && plan.bid.size > 0) {
      if (bidCrosses) {
        log(`${state.symbol}: bid skipped, would cross the live book (bid ${plan.bid.price.toFixed(4)} >= ask ${reading.bestAsk?.toFixed(4)})`);
      } else {
        try {
          const res = await submitOrder(orderCtx, { market: state.market, onchain: state.onchain, outcome: "YES", side: "buy", price: plan.bid.price, size: plan.bid.size, type: "post-only" });
          if (res.orderId !== undefined) {
            state.resting.bid = { orderId: res.orderId, price: res.price };
            state.allOrders.set(res.orderId, { side: "bid", price: res.price });
            log(`${state.symbol}: placed bid ${res.size}@${res.price} orderId=${res.orderId} hash=${res.hash}`);
          }
        } catch (e) {
          log(`${state.symbol}: bid placement failed (${(e as Error).message})`);
        }
      }
    }
    if (plan.ask.active && plan.ask.size > 0) {
      if (askCrosses) {
        log(`${state.symbol}: ask skipped, would cross the live book (ask ${plan.ask.price.toFixed(4)} <= bid ${reading.bestBid?.toFixed(4)})`);
      } else {
        try {
          const capped = await sellableSize(orderCtx as unknown as EcContext, state.onchain, "YES", plan.ask.size);
          if (capped <= 0) {
            log(`${state.symbol}: ask skipped, no sellable YES inventory left (wanted ${plan.ask.size.toFixed(3)})`);
          } else {
            const res = await submitOrder(orderCtx, { market: state.market, onchain: state.onchain, outcome: "YES", side: "sell", price: plan.ask.price, size: capped, type: "post-only" });
            if (res.orderId !== undefined) {
              state.resting.ask = { orderId: res.orderId, price: res.price };
              state.allOrders.set(res.orderId, { side: "ask", price: res.price });
              log(`${state.symbol}: placed ask ${res.size}@${res.price} orderId=${res.orderId} hash=${res.hash}${capped < plan.ask.size ? ` (capped from ${plan.ask.size.toFixed(3)} by inventory)` : ""}`);
            }
          }
        } catch (e) {
          log(`${state.symbol}: ask placement failed (${(e as Error).message})`);
        }
      }
    }
  }

  async function cycle(): Promise<void> {
    await rotate();
    if (active.size === 0) {
      log("no market currently quoted, waiting for one to enter the ttl window");
      return;
    }

    // Pass A: fresh fair value + net position for every active market this cycle.
    // tickSize/lotSize come from the pool's own getOrderBookParameters() (via
    // lucid-core's getFairValueWithBook -> getMarketDefinition), never from a
    // config default: a pool's real grid can differ from any global env value.
    const readings = new Map<string, Reading>();
    for (const state of active.values()) {
      try {
        const fv = await getFairValueWithBook(ctx, state.market, { fallbackVolatility: FALLBACK_VOL });
        const net = DRY_RUN ? state.pnl.position : await getNetPosition(ctx, state.onchain);
        readings.set(state.symbol, {
          fairYes: fv.fairYes,
          volatility: fv.volatility,
          netPosition: net,
          bestBid: fv.book.bestBid,
          bestAsk: fv.book.bestAsk,
          spot: fv.spot,
          tickSize: fv.definition.tickSize,
          lotSize: fv.definition.lotSize,
        });
      } catch (e) {
        log(`${state.symbol}: pricing read failed this cycle, skipping (${(e as Error).message})`);
      }
    }

    // Pass B: global exposure this cycle, computed once so every market's
    // effective cap in Pass C reflects every other market's current state.
    const totalExposure = globalExposure([...readings.values()].map((r) => ({ netPosition: r.netPosition, fairYes: r.fairYes })));

    // quotedCount and bothSidesCount both increment inside quoteOneMarket, at
    // the same point, right after the plan is computed and logged: "quoted"
    // means a plan was computed and shown, whether or not the placement that
    // follows later succeeds, so a placement failure on one market can never
    // pull the two counts out of sync with each other.
    const counters = { quotedCount: 0, bothSidesCount: 0, guardEngagedCount: 0 };

    // Pass C: plan, guard, and place per market, isolated so one market's
    // error cannot skip the others in this same cycle.
    for (const state of active.values()) {
      const reading = readings.get(state.symbol);
      if (!reading) continue;
      const own = marketNotional(reading.netPosition, reading.fairYes);
      try {
        await quoteOneMarket(state, reading, totalExposure - own, counters);
      } catch (e) {
        log(`${state.symbol}: quote cycle failed, skipping this market this cycle (${(e as Error).message})`);
      }
    }

    const aggPnl = [...active.values()].reduce((sum, s) => {
      const r = readings.get(s.symbol);
      return sum + (r ? markToModelPnl(s.pnl, r.fairYes) : 0);
    }, 0);
    log(
      `cycle summary: markets=${active.size} quoted=${counters.quotedCount} twoSided=${counters.bothSidesCount}/${counters.quotedCount} trendGuardEngaged=${counters.guardEngagedCount}` +
        ` | globalExposure=${totalExposure.toFixed(3)}/${PORTFOLIO_CFG.globalMaxNotional} | aggregatePnl(markToModel)=${aggPnl.toFixed(4)}`,
    );
  }

  while (!stop) {
    try {
      await cycle();
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

  log(`shutting down, cancelling all resting orders across ${active.size} market(s)`);
  await cancelAllResting();

  let finalAggPnl = 0;
  for (const state of active.values()) {
    const verifiedNet = !DRY_RUN ? await getNetPosition(ctx, state.onchain).catch(() => state.pnl.position) : state.pnl.position;
    let finalFair = 0.5;
    try {
      finalFair = (await getFairValueWithBook(ctx, state.market, { fallbackVolatility: FALLBACK_VOL })).fairYes;
    } catch {
      // market may have left Trading between the last cycle and shutdown; 0.5 is a neutral mark for the summary line only
    }
    const marketPnl = markToModelPnl(state.pnl, finalFair);
    finalAggPnl += marketPnl;
    log(`${state.symbol}: final inventory (verified)=${verifiedNet.toFixed(3)} · internal ledger=${state.pnl.position.toFixed(3)} · pnl(mark to model)=${marketPnl.toFixed(4)}`);
  }
  log(`final aggregate pnl (mark to model)=${finalAggPnl.toFixed(4)}`);

  await shutdown(ctx as unknown as EcContext);
  log("lucid-maker-v2 stopped");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
