// Phase B: deploy AutoRedeemHandler, subscribe it to MarketFinalized on
// BinarySettlement with the corrected topic0, market left wildcard (one
// standing subscription covering every market on this venue's settlement
// singleton).
import "dotenv/config";
import { writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeEventLog, formatEther, toEventSelector } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { loadConfig } from "@dreamdex-bot-kit/ec-core";
import { Reactivity, SomniaReactivityPrecompileABI } from "@somnia-chain/reactivity";
import { compileContract } from "./compile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../.env");

const CORRECTED_TOPIC0 = "0xb1884334e955f8d8727678d4fa52dd9fc7140ff5e4ad38d358453bd400ada178" as const;

// Generous gas limit: a redeem callback (signature recovery, settlement
// storage writes, ERC20 transfer, possibly twice per market) is far
// heavier than the proof's bare emit. Still comfortably under the
// protocol's 200,000,000 max.
const HANDLER_GAS_LIMIT = 20_000_000n;
const MAX_FEE_PER_GAS = 20_000_000_000n; // 20 gwei, matches the TS SDK's own default
const PRIORITY_FEE_PER_GAS = 0n;

async function main(): Promise<void> {
  const ctx = createChainContext();
  const cfg = loadConfig();

  const balance = await ctx.publicClient.getBalance({ address: ctx.account.address });
  console.log(`deployer/subscriber: ${ctx.account.address}`);
  console.log(`balance: ${formatEther(balance)} ${ctx.net.nativeSymbol}`);

  const module = cfg.addresses.binaryModule;
  if (!module) throw new Error("binaryModule address not resolved from ec-core config for this network");
  console.log(`BinaryMarketsModule (live-resolved): ${module}`);

  const { abi, bytecode } = compileContract("AutoRedeemHandler.sol", "AutoRedeemHandler");
  console.log(`\ncompiled OK (bytecode ${bytecode.length} chars)`);

  const deployHash = await ctx.walletClient.deployContract({ abi, bytecode, args: [module], account: ctx.account, chain: ctx.walletClient.chain });
  console.log(`deploy tx: ${deployHash}`);
  const deployReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (deployReceipt.status !== "success" || !deployReceipt.contractAddress) throw new Error(`deployment failed: status=${deployReceipt.status}`);

  const handlerAddress = deployReceipt.contractAddress;
  console.log(`deployed at: ${handlerAddress}`);
  console.log(`gas used: ${deployReceipt.gasUsed}`);

  const binarySettlement = cfg.addresses.binarySettlement;
  if (!binarySettlement) throw new Error("binarySettlement not resolved");
  console.log(`\nBinarySettlement (live-resolved): ${binarySettlement}`);

  const reactivity = new Reactivity({ public: ctx.publicClient, wallet: ctx.walletClient });
  const result = await reactivity.subscribe({
    handlerContractAddress: handlerAddress,
    filter: { eventTopics: [CORRECTED_TOPIC0], emitter: binarySettlement },
    options: { priorityFeePerGas: PRIORITY_FEE_PER_GAS, maxFeePerGas: MAX_FEE_PER_GAS, gasLimit: HANDLER_GAS_LIMIT },
  });

  if (result instanceof Error) {
    console.error("subscribe failed:", result);
    process.exit(1);
  }

  console.log(`\nsubscribe tx: ${result}`);
  const subReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: result });
  console.log(`status: ${subReceipt.status}, gas used: ${subReceipt.gasUsed}`);

  let subscriptionId: bigint | null = null;
  for (const log of subReceipt.logs) {
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

  const reconfirmed = toEventSelector("MarketFinalized(uint256,address,uint64,address,uint256,bool,uint256[])");
  console.log(`\nsubscriptionId: ${subscriptionId}`);
  console.log(`gasLimit set: ${HANDLER_GAS_LIMIT}`);
  console.log(`topic0 used (MarketFinalized, corrected): ${CORRECTED_TOPIC0}`);
  console.log(`recomputed from the corrected signature just now: ${reconfirmed}, matches: ${reconfirmed === CORRECTED_TOPIC0}`);

  const line = `HERO_HANDLER_ADDRESS=${handlerAddress}\nHERO_SUBSCRIPTION_ID=${subscriptionId}\n`;
  if (existsSync(envPath) && readFileSync(envPath, "utf8").includes("HERO_HANDLER_ADDRESS=")) {
    console.log("\nHERO_HANDLER_ADDRESS already set in .env, not overwriting.");
  } else {
    appendFileSync(envPath, line);
    console.log("\nwrote HERO_HANDLER_ADDRESS and HERO_SUBSCRIPTION_ID to .env");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
