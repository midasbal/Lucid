// Step 3: pick the live binary market with the soonest settlement, subscribe
// ReactiveHitHandler to BinarySettlement's MarketFinalized event via the
// 0x0100 precompile (and, cheaply, Redeemed too), and record each
// subscriptionId.
//
// MarketFinalized is the primary target: it fires automatically at every
// market's expiry as part of the reactivity-driven settlement flow itself
// (NOTES.md's Gate B write-up), no user action required, and carries
// winningOutcome directly.
//
// Redeemed is added as a second, separate subscription (topic0 has no OR
// support, so two distinct events need two subscriptions) because it is
// cheap to add. Its trigger condition is different though: it only fires
// when a holder actually calls redeem after a market settles, which is a
// user action, not an automatic consequence of expiry. It will NOT
// necessarily fire on "the very next settlement" the way MarketFinalized
// does; it fires whenever the next redeem happens on any market, which
// could be well after that market's own settlement, or before, from a
// market that settled earlier. Both subscriptions target the same emitter,
// BinarySettlement, resolved live.
//
//   npx tsx src/03-subscribe.ts

import "dotenv/config";
import { toEventSelector, decodeEventLog, formatEther } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, loadConfig, resolveVenue, activeMarkets, marketOnchain, MARKET_STATUS, shutdown } from "@dreamdex-bot-kit/ec-core";
import { Reactivity, SomniaReactivityPrecompileABI, defaultSubscriptionOptions } from "@somnia-chain/reactivity";

// Both transcribed verbatim from @somnia-chain/markets-sdk/src/eventsAbi.ts,
// binarySettlementEventsAbi (the settlement-singleton contract's events, not
// the same-named module-level MarketFinalized with a different signature).
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
    { name: "winningOutcome", type: "uint8", indexed: false },
  ],
  anonymous: false,
} as const;

const REDEEMED_ABI_ITEM = {
  type: "event",
  name: "Redeemed",
  inputs: [
    { name: "marketKey", type: "uint256", indexed: true },
    { name: "holder", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "outcomeIdx", type: "uint8", indexed: false },
    { name: "amountBurned", type: "uint256", indexed: false },
    { name: "collateralOut", type: "uint256", indexed: false },
  ],
  anonymous: false,
} as const;

const TARGETS = [
  { label: "MarketFinalized", abiItem: MARKET_FINALIZED_ABI_ITEM, signature: "MarketFinalized(uint256,address,uint64,address,uint256,bool,uint8)" },
  { label: "Redeemed", abiItem: REDEEMED_ABI_ITEM, signature: "Redeemed(uint256,address,address,uint8,uint256,uint256)" },
] as const;

async function main(): Promise<void> {
  const handlerAddress = process.env.HANDLER_ADDRESS as `0x${string}` | undefined;
  if (!handlerAddress) throw new Error("HANDLER_ADDRESS not set - run 02-deploy.ts first.");

  const ctx = createChainContext();
  const balance = await ctx.publicClient.getBalance({ address: ctx.account.address });
  console.log(`subscriber : ${ctx.account.address}`);
  console.log(`balance    : ${formatEther(balance)} ${ctx.net.nativeSymbol}`);

  const ecCfg = loadConfig();
  const binarySettlement = ecCfg.addresses.binarySettlement;
  if (!binarySettlement) throw new Error("binarySettlement address not resolved from ec-core config for this network.");
  console.log(`BinarySettlement (live-resolved): ${binarySettlement}`);

  const ecCtx = createExchange({ withSigner: false });
  await ecCtx.exchange.loadMarkets(true);
  await resolveVenue(ecCtx);

  const markets = await activeMarkets(ecCtx, { max: 1e6 });
  let soonest: { symbol: string; marketId: `0x${string}`; expiry: bigint } | null = null;
  for (const m of markets) {
    if (m.info.marketType !== "BINARY") continue;
    const onchain = await marketOnchain(ecCtx, m);
    if (!onchain || onchain.status !== MARKET_STATUS.Trading) continue;
    if (!soonest || onchain.expiry < soonest.expiry) {
      soonest = { symbol: m.symbol, marketId: m.info.marketId as `0x${string}`, expiry: onchain.expiry };
    }
  }
  if (!soonest) throw new Error("No live Trading market found to target.");

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const ttlSec = soonest.expiry - nowSec;
  console.log(`\ntarget market (soonest expiry, status Trading): ${soonest.symbol}`);
  console.log(`marketId     : ${soonest.marketId}`);
  console.log(`expiry       : ${soonest.expiry} (unix sec), ttl ~${(Number(ttlSec) / 60).toFixed(1)} min`);

  await shutdown(ecCtx);

  const reactivity = new Reactivity({ public: ctx.publicClient, wallet: ctx.walletClient });

  const results: { label: string; topic0: `0x${string}`; signature: string; subscribeTx: `0x${string}`; subscriptionId: bigint; gasUsed: bigint }[] = [];

  for (const target of TARGETS) {
    const topic0 = toEventSelector(target.abiItem);
    console.log(`\n--- ${target.label} ---`);
    console.log(`signature: ${target.signature}`);
    console.log(`topic0 (keccak256 of the signature above, via viem toEventSelector): ${topic0}`);

    const result = await reactivity.subscribe({
      handlerContractAddress: handlerAddress,
      filter: {
        eventTopics: [topic0],
        emitter: binarySettlement as `0x${string}`,
      },
      options: defaultSubscriptionOptions,
    });

    if (result instanceof Error) {
      console.error(`\nsubscribe() failed for ${target.label}:`);
      console.error(result);
      process.exit(1);
    }

    console.log(`subscribe tx: ${result}`);
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: result });
    console.log(`status: ${receipt.status}, gas used: ${receipt.gasUsed}`);

    let subscriptionId: bigint | null = null;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: SomniaReactivityPrecompileABI, data: log.data, topics: log.topics });
        if (decoded.eventName === "SubscriptionCreated") {
          subscriptionId = (decoded.args as { subscriptionId: bigint }).subscriptionId;
          break;
        }
      } catch {
        continue;
      }
    }

    if (subscriptionId === null) {
      console.log(`\nCould not find SubscriptionCreated in the receipt logs for ${target.label} - check the tx manually.`);
      process.exit(1);
    }

    console.log(`subscriptionId: ${subscriptionId}`);
    results.push({ label: target.label, topic0, signature: target.signature, subscribeTx: result, subscriptionId, gasUsed: receipt.gasUsed });
  }

  console.log(`\nRecord these in PROOF.md:`);
  console.log(`  market:  ${soonest.symbol} (${soonest.marketId})`);
  console.log(`  emitter: ${binarySettlement}`);
  console.log(`  handler: ${handlerAddress}`);
  for (const r of results) {
    console.log(`  [${r.label}] signature=${r.signature} topic0=${r.topic0} subscribeTx=${r.subscribeTx} subscriptionId=${r.subscriptionId} gasUsed=${r.gasUsed}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
