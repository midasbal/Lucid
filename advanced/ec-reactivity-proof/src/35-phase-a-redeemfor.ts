// Phase A step 3-4: after the market finalizes, decode payoutNumerators to
// find the winning side, then call redeemFor FROM THE RELAYER with that
// side's pre-signed authorization. Confirms the call succeeds, the payout
// lands with the OWNER (not the relayer), and the relayer only spent gas.
import { config as dotenv } from "dotenv";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeEventLog, formatEther } from "viem";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.resolve(__dirname, "../.env.relayer") });

// Load the relayer key into PRIVATE_KEY BEFORE importing anything that reads
// it at module-eval time, so createExchange/createChainContext pick up the
// relayer, not the main EOA's key from ../.env.
const relayerKey = process.env.RELAYER_PRIVATE_KEY;
if (!relayerKey) throw new Error("RELAYER_PRIVATE_KEY not set - run 32-phase-a-relayer.ts first");
process.env.PRIVATE_KEY = relayerKey;
process.env.NETWORK = "testnet";

const { createChainContext } = await import("@dreamdex-bot-kit/core");
const { createExchange, loadConfig } = await import("@dreamdex-bot-kit/ec-core");
const { toHuman } = await import("@somnia-chain/markets-sdk");

const MARKET_ID = "0x0000000000000000000000000000000000000000000000000000000000004702" as `0x${string}`;
const AUTHS_FILE = "phase-a2-auths.json";
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

async function findBlockNear(ctx: Awaited<ReturnType<typeof createChainContext>>, targetTimestampSec: bigint): Promise<bigint> {
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

  console.log(`relayer address (signer for this script): ${ctx.account.address}`);
  const relayerBalBefore = await ctx.publicClient.getBalance({ address: ctx.account.address });
  console.log(`relayer STT balance: ${formatEther(relayerBalBefore)}`);

  const auths = JSON.parse(readFileSync(path.resolve(__dirname, "..", AUTHS_FILE), "utf8"));
  const owner = auths.owner as `0x${string}`;
  console.log(`owner (from ${AUTHS_FILE}): ${owner}`);

  const onchain = await ecCtx.exchange.client.getMarketOnchain(MARKET_ID);
  if (!onchain) throw new Error("no onchain snapshot");
  if (!onchain.finalized) {
    const ttl = Number(onchain.expiry) - Date.now() / 1000;
    console.log(`market not finalized yet. status=${onchain.status}, ttl=${(ttl / 60).toFixed(1)}min`);
    process.exit(1);
  }

  const binarySettlement = cfg.addresses.binarySettlement as `0x${string}`;
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

  let ourLog: (typeof logs)[number] | undefined;
  for (const log of logs) {
    const decoded = decodeEventLog({ abi: [MARKET_FINALIZED_ABI_ITEM], data: log.data, topics: log.topics });
    const args = decoded.args as unknown as { pool: `0x${string}`; nonce: bigint };
    if (args.pool.toLowerCase() === onchain.pool.toLowerCase() && args.nonce === onchain.nonce) {
      ourLog = log;
      break;
    }
  }
  if (!ourLog) throw new Error("could not find our market's MarketFinalized log");

  const decoded = decodeEventLog({ abi: [MARKET_FINALIZED_ABI_ITEM], data: ourLog.data, topics: ourLog.topics });
  const args = decoded.args as unknown as { payoutNumerators: readonly bigint[] };
  console.log(`\ndecoded payoutNumerators: ${JSON.stringify(args.payoutNumerators.map(String))}`);

  let winningOutcome = 0;
  for (let i = 1; i < args.payoutNumerators.length; i++) {
    if ((args.payoutNumerators[i] ?? 0n) > (args.payoutNumerators[winningOutcome] ?? 0n)) winningOutcome = i;
  }
  console.log(`winning outcome: ${winningOutcome} (0=YES, 1=NO)`);

  const authKey = winningOutcome === 0 ? "yesAuth" : "noAuth";
  const rawAuth = auths[authKey];
  const authorization = {
    owner: rawAuth.owner as `0x${string}`,
    operatorId: rawAuth.operatorId as number,
    venueId: rawAuth.venueId as `0x${string}`,
    marketId: rawAuth.marketId as `0x${string}`,
    outcomeIdx: rawAuth.outcomeIdx as 0 | 1,
    amount: BigInt(rawAuth.amount),
    nonce: BigInt(rawAuth.nonce),
    deadline: BigInt(rawAuth.deadline),
    signature: rawAuth.signature as `0x${string}`,
  };
  console.log(`\nusing ${authKey}: ${JSON.stringify(authorization, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);

  const collateral = cfg.addresses.collateral ?? cfg.addresses.testUsdc!;
  const ownerBalBefore = await ecCtx.exchange.client.getErc20Balance(collateral, owner);
  const relayerTusdcBefore = await ecCtx.exchange.client.getErc20Balance(collateral, ctx.account.address);
  console.log(`\nowner tUSDC before: ${toHuman(ownerBalBefore, cfg.decimals)}`);
  console.log(`relayer tUSDC before: ${toHuman(relayerTusdcBefore, cfg.decimals)}`);

  console.log(`\ncalling redeemFor from relayer ${ctx.account.address} ...`);
  const res = await ecCtx.exchange.trader.redeemFor({ authorization });
  console.log(`redeemFor tx: ${res.hash}`);
  console.log(`status: ${res.receipt.status}`);
  console.log(`gas used: ${res.receipt.gasUsed}`);
  console.log(`explorer: ${ctx.net.explorer}/tx/${res.hash}`);

  await new Promise((r) => setTimeout(r, 2000));

  const ownerBalAfter = await ecCtx.exchange.client.getErc20Balance(collateral, owner);
  const relayerTusdcAfter = await ecCtx.exchange.client.getErc20Balance(collateral, ctx.account.address);
  const relayerBalAfter = await ctx.publicClient.getBalance({ address: ctx.account.address });

  console.log(`\n=== RESULTS ===`);
  console.log(`owner tUSDC after: ${toHuman(ownerBalAfter, cfg.decimals)} (change: ${toHuman(ownerBalAfter - ownerBalBefore, cfg.decimals)})`);
  console.log(`relayer tUSDC after: ${toHuman(relayerTusdcAfter, cfg.decimals)} (change: ${toHuman(relayerTusdcAfter - relayerTusdcBefore, cfg.decimals)})`);
  console.log(`relayer STT before: ${formatEther(relayerBalBefore)}, after: ${formatEther(relayerBalAfter)}, spent: ${formatEther(relayerBalBefore - relayerBalAfter)}`);
  console.log(`\npayout landed with owner: ${ownerBalAfter > ownerBalBefore}`);
  console.log(`relayer received no tUSDC: ${relayerTusdcAfter === relayerTusdcBefore}`);
  console.log(`relayer only spent gas (STT decreased, no other change): ${relayerBalAfter < relayerBalBefore}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
