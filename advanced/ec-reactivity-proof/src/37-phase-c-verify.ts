// Phase C verification: confirm the handler auto-redeemed the winning side
// with no further action from us. Checks the handler's own AutoRedeemed
// event, the underlying reactive transaction (synthetic nonce, from the
// subscription owner), and the owner's collateral balance delta.
import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, loadConfig } from "@dreamdex-bot-kit/ec-core";
import { toHuman } from "@somnia-chain/markets-sdk";

const MARKET_KEY = process.env.PHASE_C_MARKET_KEY;
const OWNER_TUSDC_BEFORE = process.env.PHASE_C_OWNER_BALANCE_BEFORE;

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
] as const;

async function main(): Promise<void> {
  if (!MARKET_KEY) throw new Error("set PHASE_C_MARKET_KEY env var to the marketKey from 36-phase-c-setup.ts output");

  const ctx = createChainContext();
  const cfg = loadConfig();
  const ecCtx = createExchange({ withSigner: false });
  const handlerAddress = process.env.HERO_HANDLER_ADDRESS as `0x${string}`;

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

  const match = logs.find((l) => l.args.marketKey === BigInt(MARKET_KEY));
  if (!match) {
    console.log(`No AutoRedeemed event found yet for marketKey ${MARKET_KEY}. Not fired yet, or market not finalized yet.`);
    console.log(`(found ${logs.length} AutoRedeemed events total for other markets)`);
    process.exit(1);
  }

  console.log(`AutoRedeemed found: tx=${match.transactionHash} block=${match.blockNumber}`);
  console.log(`args: ${JSON.stringify(match.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  console.log(`explorer: ${ctx.net.explorer}/tx/${match.transactionHash}`);

  const receipt = await ctx.publicClient.getTransactionReceipt({ hash: match.transactionHash });
  const tx = await ctx.publicClient.getTransaction({ hash: match.transactionHash });
  console.log(`\ntx.from: ${tx.from}`);
  console.log(`tx.nonce: ${tx.nonce}`);
  console.log(`gas used: ${receipt.gasUsed}`);

  const ourRegularNonce = await ctx.publicClient.getTransactionCount({ address: ctx.account.address });
  console.log(`our account's current regular nonce: ${ourRegularNonce}`);
  console.log(`tx.nonce is synthetic (far from our regular nonce): ${tx.nonce > ourRegularNonce + 1000}`);

  const owner = match.args.owner!;
  const collateral = cfg.addresses.collateral ?? cfg.addresses.testUsdc!;
  const ownerBalNow = await ecCtx.exchange.client.getErc20Balance(collateral, owner);
  console.log(`\nowner (${owner}) tUSDC now: ${toHuman(ownerBalNow, cfg.decimals)}`);
  if (OWNER_TUSDC_BEFORE) {
    const before = BigInt(OWNER_TUSDC_BEFORE);
    console.log(`owner tUSDC before (from env): ${toHuman(before, cfg.decimals)}`);
    console.log(`change: ${toHuman(ownerBalNow - before, cfg.decimals)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
