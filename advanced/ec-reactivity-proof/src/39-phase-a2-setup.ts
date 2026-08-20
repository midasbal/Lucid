// Phase A gate, re-run on a fresh short-dated market: take both sides, sign
// both RedeemAuthorizations, write phase-a2-auths.json. Combined into one
// script to move fast against a short ttl.
import "dotenv/config";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAbi } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, loadConfig, resolveVenue, activeMarkets, marketOnchain, outcomeSymbols, MARKET_STATUS, placeLimit } from "@dreamdex-bot-kit/ec-core";
import { marketKey, toHuman } from "@somnia-chain/markets-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET_SYMBOL = "BTC-0-19AUG26-1730/tUSDC";
const NOTIONAL_PER_SIDE = 3;
const BOOK_PARAMS_ABI = parseAbi(["function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))"]);

function jsonSafe(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val)));
}

async function main(): Promise<void> {
  const ctx = createChainContext();
  const cfg = loadConfig();
  const ecCtx = createExchange({ withSigner: true });
  await ecCtx.exchange.loadMarkets(true);
  await resolveVenue(ecCtx);

  const markets = await activeMarkets(ecCtx, { max: 1e6 });
  const market = markets.find((m) => m.symbol === TARGET_SYMBOL);
  if (!market) throw new Error(`${TARGET_SYMBOL} not active`);

  const onchain = await marketOnchain(ecCtx, market);
  if (!onchain || onchain.status !== MARKET_STATUS.Trading) throw new Error(`not Trading (status=${onchain?.status})`);
  const marketId = market.info.marketType === "BINARY" ? market.info.marketId : "";

  const ttlMin = (Number(onchain.expiry) - Date.now() / 1000) / 60;
  console.log(`market: ${market.symbol}, marketId: ${marketId}, ttl: ${ttlMin.toFixed(2)}min`);

  const params = await ctx.publicClient.readContract({ address: onchain.pool, abi: BOOK_PARAMS_ABI, functionName: "getOrderBookParameters" });
  console.log(`live pool params: tick=${params.tickSize} minQty=${params.minQuantity} lot=${params.lotSize}`);
  if (params.lotSize !== cfg.lot) {
    console.log(`MISMATCH vs ec-core config lot=${cfg.lot}: set MM_LOT=${params.lotSize} and re-run.`);
    process.exit(1);
  }

  const { yes, no } = outcomeSymbols(market);

  const yesBook = await ecCtx.exchange.fetchOrderBook(yes, 5);
  const yesBestAsk = yesBook.asks[0]?.[0];
  if (yesBestAsk === undefined) throw new Error("YES book has no asks");
  const yesCrossPrice = Math.min(yesBestAsk + 0.02, 0.98);
  const yesSize = NOTIONAL_PER_SIDE / yesCrossPrice;
  const yesResult = await placeLimit(ecCtx, { market, onchain, outcome: "YES", side: "buy", price: yesCrossPrice, size: yesSize, type: "ioc" });
  console.log(`YES fill: ${yesResult.filled} @ ${yesResult.price} hash=${yesResult.hash}`);

  const noBook = await ecCtx.exchange.fetchOrderBook(no, 5);
  const noBestAsk = noBook.asks[0]?.[0];
  if (noBestAsk === undefined) throw new Error("NO book has no asks");
  const noCrossPrice = Math.min(noBestAsk + 0.02, 0.98);
  const noSize = NOTIONAL_PER_SIDE / noCrossPrice;
  const noResult = await placeLimit(ecCtx, { market, onchain, outcome: "NO", side: "buy", price: noCrossPrice, size: noSize, type: "ioc" });
  console.log(`NO fill: ${noResult.filled} @ ${noResult.price} hash=${noResult.hash}`);

  await new Promise((r) => setTimeout(r, 1500));

  const yesBal = await ecCtx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: ctx.account.address, id: onchain.yesId });
  const noBal = await ecCtx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: ctx.account.address, id: onchain.noId });
  console.log(`YES balance: ${toHuman(yesBal, cfg.decimals)} (raw ${yesBal})`);
  console.log(`NO balance: ${toHuman(noBal, cfg.decimals)} (raw ${noBal})`);

  const key = marketKey(onchain.yesId);
  const nowSec = Math.floor(Date.now() / 1000);
  const deadline = BigInt(nowSec + 2 * 60 * 60);
  const baseNonce = BigInt(Date.now()) * 1000n;

  const yesAuth = await ecCtx.exchange.trader.signRedeemAuth({ marketId: marketId as `0x${string}`, outcomeIdx: 0, amount: yesBal, nonce: baseNonce + 1n, deadline });
  const noAuth = await ecCtx.exchange.trader.signRedeemAuth({ marketId: marketId as `0x${string}`, outcomeIdx: 1, amount: noBal, nonce: baseNonce + 2n, deadline });

  console.log(`\nmarketKey: ${key}`);
  console.log(`YES auth nonce=${yesAuth.nonce} deadline=${yesAuth.deadline}`);
  console.log(`NO auth nonce=${noAuth.nonce} deadline=${noAuth.deadline}`);

  const outPath = path.resolve(__dirname, "../phase-a2-auths.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        marketKey: key.toString(),
        marketId,
        symbol: market.symbol,
        pool: onchain.pool,
        nonce: onchain.nonce.toString(),
        expiry: onchain.expiry.toString(),
        owner: ctx.account.address,
        yesAuth: jsonSafe(yesAuth),
        noAuth: jsonSafe(noAuth),
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
