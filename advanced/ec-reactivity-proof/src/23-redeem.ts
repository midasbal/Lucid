// Step 5: after our market finalizes, decode payoutNumerators from the real
// on-chain MarketFinalized log ourselves (not just trust onchain.winningOutcome),
// derive the winning outcome by argmax, then redeem through the raw trader
// tier with that outcome explicit. Confirms collateral returns (or, on a
// loss, confirms the redeem succeeds and pays exactly zero).
import "dotenv/config";
import { decodeEventLog } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, loadConfig, assertTxOk } from "@dreamdex-bot-kit/ec-core";
import { toHuman } from "@somnia-chain/markets-sdk";

const MARKET_ID = "0x00000000000000000000000000000000000000000000000000000000000046f1" as `0x${string}`;
const CORRECTED_TOPIC0 = "0xb1884334e955f8d8727678d4fa52dd9fc7140ff5e4ad38d358453bd400ada178" as const;

const MARKET_FINALIZED_ABI_ITEM = {
  type: "event",
  name: "MarketFinalized",
  inputs: [
    { name: "marketKey", type: "uint256", indexed: true },
    { name: "pool", type: "address", indexed: true },
    { name: "nonce", type: "uint64", indexed: false },
    { name: "collateralToken", type: "address", indexed: false },
    { name: "netBacking", type: "uint256", indexed: false },
    { name: "voided", type: "bool", indexed: false },
    { name: "payoutNumerators", type: "uint256[]", indexed: false },
  ],
  anonymous: false,
} as const;

async function findBlockNear(ctx: ReturnType<typeof createChainContext>, targetTimestampSec: bigint): Promise<bigint> {
  let hi = await ctx.publicClient.getBlockNumber();
  let lo = hi > 200_000n ? hi - 200_000n : 0n;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const block = await ctx.publicClient.getBlock({ blockNumber: mid });
    if (block.timestamp < targetTimestampSec) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

async function main(): Promise<void> {
  const ctx = createChainContext();
  const cfg = loadConfig();
  const ecCtx = createExchange({ withSigner: true });

  const onchain = await ecCtx.exchange.client.getMarketOnchain(MARKET_ID);
  if (!onchain) throw new Error("no onchain snapshot");
  if (!onchain.finalized) throw new Error("market not finalized yet");

  const binarySettlement = cfg.addresses.binarySettlement as `0x${string}`;

  // Search a window around the market's own expiry timestamp, not "recent
  // blocks" - loadMarkets() / a fixed recent-block window both miss a
  // market that finalized a while ago (gotcha: settled markets age out of
  // the live list, and a fixed recent-block window can simply be too late
  // if enough time passed before this script ran).
  const searchStart = await findBlockNear(ctx, onchain.expiry - 60n);
  const latest = await ctx.publicClient.getBlockNumber();
  console.log(`searching blocks ${searchStart} to ${latest} for our market's MarketFinalized log`);

  const logs: Awaited<ReturnType<typeof ctx.publicClient.getLogs>> = [];
  let cursor = searchStart;
  while (cursor <= latest) {
    const to = cursor + 900n < latest ? cursor + 900n : latest;
    const chunk = await ctx.publicClient.getLogs({
      address: binarySettlement,
      topics: [CORRECTED_TOPIC0],
      fromBlock: cursor,
      toBlock: to,
    } as Parameters<typeof ctx.publicClient.getLogs>[0]);
    logs.push(...chunk);
    cursor = to + 1n;
  }

  console.log(`found ${logs.length} MarketFinalized log(s) in window`);

  let ourLog: (typeof logs)[number] | undefined;
  for (const log of logs) {
    const decoded = decodeEventLog({ abi: [MARKET_FINALIZED_ABI_ITEM], data: log.data, topics: log.topics });
    const args = decoded.args as unknown as { pool: `0x${string}`; nonce: bigint };
    if (args.pool.toLowerCase() === onchain.pool.toLowerCase() && args.nonce === onchain.nonce) {
      ourLog = log;
      break;
    }
  }

  let winningOutcomeOurs: number | null = null;
  if (!ourLog) {
    console.log("Could not find our market's own MarketFinalized log by pool+nonce match. Falling back to onchain.winningOutcome only.");
  } else {
    const decoded = decodeEventLog({ abi: [MARKET_FINALIZED_ABI_ITEM], data: ourLog.data, topics: ourLog.topics });
    console.log(`\nOur market's MarketFinalized log: tx=${ourLog.transactionHash} block=${ourLog.blockNumber}`);
    console.log(`decoded: ${JSON.stringify(decoded.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    console.log(`explorer: ${ctx.net.explorer}/tx/${ourLog.transactionHash}`);

    const args = decoded.args as unknown as { payoutNumerators: readonly bigint[]; voided: boolean };
    winningOutcomeOurs = 0;
    for (let i = 1; i < args.payoutNumerators.length; i++) {
      if ((args.payoutNumerators[i] ?? 0n) > (args.payoutNumerators[winningOutcomeOurs] ?? 0n)) winningOutcomeOurs = i;
    }
    console.log(`\nour own argmax(payoutNumerators) = outcome ${winningOutcomeOurs} (0=YES, 1=NO)`);
    console.log(`onchain.winningOutcome (SDK-derived)          = outcome ${onchain.winningOutcome}`);
    console.log(`voided (our decode): ${args.voided}, onchain.isVoided: ${onchain.isVoided}`);
    console.log(`match: ${winningOutcomeOurs === onchain.winningOutcome}`);
  }

  const yesBal = await ecCtx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: ctx.account.address, id: onchain.yesId });
  console.log(`\nheld YES balance: ${toHuman(yesBal, cfg.decimals)} (raw ${yesBal})`);

  const won = (winningOutcomeOurs ?? onchain.winningOutcome) === 0;
  console.log(`our YES position ${won ? "WON" : "LOST"}`);

  const collateral = cfg.addresses.collateral ?? cfg.addresses.testUsdc!;
  const before = await ecCtx.exchange.client.getErc20Balance(collateral, ctx.account.address);
  console.log(`\ntUSDC balance before redeem: ${toHuman(before, cfg.decimals)}`);

  // Raw trader tier, direct: BinaryMarketsModule.redeem, explicit outcomeIdx
  // (0 = YES, the side we hold), against the marketId, market address, and
  // outcome-token singleton we already resolved from getMarketOnchain.
  console.log(`\nredeem call: exchange.trader.redeem({ marketId: ${MARKET_ID}, market: ${onchain.marketAddress}, outcomeToken: ${onchain.outcomeToken}, outcomeIdx: 0, amount: ${yesBal} })`);

  const res = await ecCtx.exchange.trader.redeem({
    marketId: MARKET_ID,
    market: onchain.marketAddress,
    outcomeToken: onchain.outcomeToken,
    outcomeIdx: 0,
    amount: yesBal,
  });
  assertTxOk(res, "redeem YES");

  console.log(`\nredeem tx: ${res.hash}`);
  console.log(`status: ${res.receipt.status}`);
  console.log(`gas used: ${res.receipt.gasUsed}`);
  console.log(`explorer: ${ctx.net.explorer}/tx/${res.hash}`);

  await new Promise((r) => setTimeout(r, 2000));
  const after = await ecCtx.exchange.client.getErc20Balance(collateral, ctx.account.address);
  console.log(`\ntUSDC balance after redeem: ${toHuman(after, cfg.decimals)}`);
  console.log(`collateral change: ${toHuman(after - before, cfg.decimals)}`);

  const yesAfter = await ecCtx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: ctx.account.address, id: onchain.yesId });
  console.log(`YES balance after redeem: ${toHuman(yesAfter, cfg.decimals)} (raw ${yesAfter})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
