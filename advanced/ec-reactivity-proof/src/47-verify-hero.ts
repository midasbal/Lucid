import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, loadConfig, MARKET_STATUS } from "@dreamdex-bot-kit/ec-core";
import { toHuman } from "@somnia-chain/markets-sdk";

const MARKET_ID = ("0x" + "4707".padStart(64, "0")) as `0x${string}`;
const MARKET_KEY = 2040732934468698939554459975902734157505744126128863482567259586562n;
const OWNER = "0xE4eA8b4FC1BBFf290f3Dbd29CE8471348de860dB" as `0x${string}`;
const OWNER_BASELINE_RAW = 9979923409n;

const HANDLER_ABI = [
  {
    type: "event",
    name: "AutoRedeemed",
    inputs: [
      { name: "marketKey", type: "uint256", indexed: true },
      { name: "outcomeIdx", type: "uint8", indexed: false },
      { name: "owner", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "function",
    name: "auths",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }, { name: "", type: "uint256" }],
    outputs: [
      { name: "owner", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "sig", type: "bytes" },
      { name: "operatorId", type: "uint32" },
      { name: "venueId", type: "bytes32" },
      { name: "marketId", type: "bytes32" },
      { name: "redeemed", type: "bool" },
    ],
  },
] as const;

async function main(): Promise<void> {
  const ctx = createChainContext();
  const cfg = loadConfig();
  const ecCtx = createExchange({ withSigner: false });
  const handlerAddress = process.env.HERO_HANDLER_ADDRESS as `0x${string}`;

  console.log("=== 1. Market status ===");
  const onchain = await ecCtx.exchange.client.getMarketOnchain(MARKET_ID);
  console.log(JSON.stringify(onchain, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  const statusName = Object.keys(MARKET_STATUS).find((k) => MARKET_STATUS[k as keyof typeof MARKET_STATUS] === onchain?.status);
  console.log(`status: ${statusName}`);

  console.log("\n=== 2. Auth redeemed flags ===");
  const yesAuth = await ctx.publicClient.readContract({ address: handlerAddress, abi: HANDLER_ABI, functionName: "auths", args: [MARKET_KEY, 0n] });
  const noAuth = await ctx.publicClient.readContract({ address: handlerAddress, abi: HANDLER_ABI, functionName: "auths", args: [MARKET_KEY, 1n] });
  console.log(`YES auth redeemed: ${yesAuth[8]}`);
  console.log(`NO auth redeemed: ${noAuth[8]}`);

  console.log("\n=== 3. AutoRedeemed events for this marketKey ===");
  const latest = await ctx.publicClient.getBlockNumber();
  const from = latest - 100_000n > 0n ? latest - 100_000n : 0n;
  const logs: Awaited<ReturnType<typeof ctx.publicClient.getContractEvents<typeof HANDLER_ABI, "AutoRedeemed">>> = [];
  let cursor = from;
  while (cursor <= latest) {
    const to = cursor + 900n < latest ? cursor + 900n : latest;
    const chunk = await ctx.publicClient.getContractEvents({ address: handlerAddress, abi: HANDLER_ABI, eventName: "AutoRedeemed", fromBlock: cursor, toBlock: to });
    logs.push(...chunk);
    cursor = to + 1n;
  }
  const match = logs.filter((l) => l.args.marketKey === MARKET_KEY);
  console.log(`found ${match.length} AutoRedeemed event(s) for this marketKey`);
  for (const m of match) {
    console.log(`  tx=${m.transactionHash} block=${m.blockNumber} args=${JSON.stringify(m.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  }

  if (match.length > 0) {
    const m = match[0]!;
    const receipt = await ctx.publicClient.getTransactionReceipt({ hash: m.transactionHash });
    const tx = await ctx.publicClient.getTransaction({ hash: m.transactionHash });
    console.log(`\ntx.from: ${tx.from}`);
    console.log(`tx.nonce: ${tx.nonce}`);
    console.log(`gasUsed: ${receipt.gasUsed}`);
    const ourRegularNonce = await ctx.publicClient.getTransactionCount({ address: ctx.account.address });
    console.log(`our real account nonce right now: ${ourRegularNonce}`);
    console.log(`tx.nonce is synthetic: ${tx.nonce > ourRegularNonce + 1000}`);
    console.log(`explorer: ${ctx.net.explorer}/tx/${m.transactionHash}`);
  }

  console.log("\n=== 4. Owner balance ===");
  const collateral = cfg.addresses.collateral ?? cfg.addresses.testUsdc!;
  const ownerBalNow = await ecCtx.exchange.client.getErc20Balance(collateral, OWNER);
  console.log(`owner tUSDC now: ${toHuman(ownerBalNow, cfg.decimals)} (raw ${ownerBalNow})`);
  console.log(`owner tUSDC baseline: ${toHuman(OWNER_BASELINE_RAW, cfg.decimals)} (raw ${OWNER_BASELINE_RAW})`);
  console.log(`change: ${toHuman(ownerBalNow - OWNER_BASELINE_RAW, cfg.decimals)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
