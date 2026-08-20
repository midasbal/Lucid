// Phase C: fresh both-sides position on a NEW live market, sign both
// authorizations, registerAuth both with the deployed handler, then stop
// acting. Prints everything needed to verify the auto-redeem later without
// any further action from us.
import "dotenv/config";
import { parseAbi } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, loadConfig, resolveVenue, activeMarkets, marketOnchain, outcomeSymbols, MARKET_STATUS, placeLimit, shutdown } from "@dreamdex-bot-kit/ec-core";
import { marketKey, toHuman } from "@somnia-chain/markets-sdk";

const NOTIONAL_PER_SIDE = 3;
const BOOK_PARAMS_ABI = parseAbi(["function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))"]);

const HANDLER_ABI = [
  {
    type: "function",
    name: "registerAuth",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketKeyValue", type: "uint256" },
      { name: "marketId", type: "bytes32" },
      { name: "outcomeIdx", type: "uint8" },
      { name: "owner", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "sig", type: "bytes" },
      { name: "operatorId", type: "uint32" },
      { name: "venueId", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

async function main(): Promise<void> {
  const ctx = createChainContext();
  const cfg = loadConfig();
  const handlerAddress = process.env.HERO_HANDLER_ADDRESS as `0x${string}` | undefined;
  if (!handlerAddress) throw new Error("HERO_HANDLER_ADDRESS not set - deploy the hero first (34-deploy-hero.ts)");

  const ecCtx = createExchange({ withSigner: true });
  await ecCtx.exchange.loadMarkets(true);
  await resolveVenue(ecCtx);

  const TARGET_SYMBOL = process.env.PHASE_C_SYMBOL ?? "ETH-0-19AUG26-1800/tUSDC";
  const markets = await activeMarkets(ecCtx, { max: 1e6 });
  let picked: { market: (typeof markets)[number]; onchain: NonNullable<Awaited<ReturnType<typeof marketOnchain>>> } | null = null;
  const m = markets.find((x) => x.symbol === TARGET_SYMBOL);
  if (!m) throw new Error(`${TARGET_SYMBOL} not active`);
  const onchainForPicked = await marketOnchain(ecCtx, m);
  if (!onchainForPicked || onchainForPicked.status !== MARKET_STATUS.Trading) throw new Error(`not Trading (status=${onchainForPicked?.status})`);
  picked = { market: m, onchain: onchainForPicked };

  const { market, onchain } = picked;
  console.log(`market: ${market.symbol}`);
  const marketId = market.info.marketType === "BINARY" ? market.info.marketId : "";
  console.log(`marketId: ${marketId}`);
  console.log(`pool: ${onchain.pool}, nonce: ${onchain.nonce}, expiry: ${onchain.expiry}`);

  const params = await ctx.publicClient.readContract({ address: onchain.pool, abi: BOOK_PARAMS_ABI, functionName: "getOrderBookParameters" });
  console.log(`live pool params: tick=${params.tickSize} minQty=${params.minQuantity} lot=${params.lotSize}, ec-core config lot=${cfg.lot}`);
  if (params.lotSize !== cfg.lot) {
    console.log(`MISMATCH: set MM_LOT=${params.lotSize} in .env and re-run.`);
    process.exit(1);
  }

  const { yes, no } = outcomeSymbols(market);

  const yesBook = await ecCtx.exchange.fetchOrderBook(yes, 5);
  const yesBestAsk = yesBook.asks[0]?.[0];
  if (yesBestAsk === undefined) throw new Error("YES book has no asks");
  const yesCrossPrice = Math.min(yesBestAsk + 0.02, 0.98);
  const yesSize = NOTIONAL_PER_SIDE / yesCrossPrice;
  const yesResult = await placeLimit(ecCtx, { market, onchain, outcome: "YES", side: "buy", price: yesCrossPrice, size: yesSize, type: "ioc" });
  console.log(`\nYES fill: ${yesResult.filled} @ ${yesResult.price}, hash=${yesResult.hash}`);

  const noBook = await ecCtx.exchange.fetchOrderBook(no, 5);
  const noBestAsk = noBook.asks[0]?.[0];
  if (noBestAsk === undefined) throw new Error("NO book has no asks");
  const noCrossPrice = Math.min(noBestAsk + 0.02, 0.98);
  const noSize = NOTIONAL_PER_SIDE / noCrossPrice;
  const noResult = await placeLimit(ecCtx, { market, onchain, outcome: "NO", side: "buy", price: noCrossPrice, size: noSize, type: "ioc" });
  console.log(`NO fill: ${noResult.filled} @ ${noResult.price}, hash=${noResult.hash}`);

  await new Promise((r) => setTimeout(r, 2000));

  const yesBal = await ecCtx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: ctx.account.address, id: onchain.yesId });
  const noBal = await ecCtx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: ctx.account.address, id: onchain.noId });
  console.log(`\nYES balance: ${toHuman(yesBal, cfg.decimals)} (raw ${yesBal})`);
  console.log(`NO balance: ${toHuman(noBal, cfg.decimals)} (raw ${noBal})`);

  const key = marketKey(onchain.yesId);
  console.log(`\nmarketKey: ${key}`);

  const nowSec = Math.floor(Date.now() / 1000);
  const deadline = BigInt(nowSec + 4 * 60 * 60);
  const baseNonce = BigInt(Date.now()) * 1000n;

  const yesAuth = await ecCtx.exchange.trader.signRedeemAuth({ marketId: marketId as `0x${string}`, outcomeIdx: 0, amount: yesBal, nonce: baseNonce + 1n, deadline });
  const noAuth = await ecCtx.exchange.trader.signRedeemAuth({ marketId: marketId as `0x${string}`, outcomeIdx: 1, amount: noBal, nonce: baseNonce + 2n, deadline });

  console.log(`\nsigned YES auth: nonce=${yesAuth.nonce} deadline=${yesAuth.deadline}`);
  console.log(`signed NO auth: nonce=${noAuth.nonce} deadline=${noAuth.deadline}`);

  console.log(`\nregistering YES auth with handler ${handlerAddress}...`);
  const regYesHash = await ctx.walletClient.writeContract({
    address: handlerAddress,
    abi: HANDLER_ABI,
    functionName: "registerAuth",
    args: [key, marketId as `0x${string}`, 0, yesAuth.owner, yesAuth.amount, yesAuth.deadline, yesAuth.nonce, yesAuth.signature, yesAuth.operatorId, yesAuth.venueId],
    account: ctx.account,
    chain: ctx.walletClient.chain,
  });
  console.log(`registerAuth(YES) tx: ${regYesHash}`);
  await ctx.publicClient.waitForTransactionReceipt({ hash: regYesHash });

  console.log(`registering NO auth...`);
  const regNoHash = await ctx.walletClient.writeContract({
    address: handlerAddress,
    abi: HANDLER_ABI,
    functionName: "registerAuth",
    args: [key, marketId as `0x${string}`, 1, noAuth.owner, noAuth.amount, noAuth.deadline, noAuth.nonce, noAuth.signature, noAuth.operatorId, noAuth.venueId],
    account: ctx.account,
    chain: ctx.walletClient.chain,
  });
  console.log(`registerAuth(NO) tx: ${regNoHash}`);
  await ctx.publicClient.waitForTransactionReceipt({ hash: regNoHash });

  console.log(`\n=== PHASE C SETUP COMPLETE ===`);
  console.log(`market: ${market.symbol} (${marketId})`);
  console.log(`marketKey: ${key}`);
  console.log(`pool: ${onchain.pool}, nonce: ${onchain.nonce}`);
  console.log(`expiry: ${onchain.expiry} (${new Date(Number(onchain.expiry) * 1000).toISOString()})`);
  console.log(`YES amount registered: ${yesBal}, NO amount registered: ${noBal}`);
  console.log(`\nNo further action needed. Waiting for MarketFinalized to trigger the handler automatically.`);

  await shutdown(ecCtx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
