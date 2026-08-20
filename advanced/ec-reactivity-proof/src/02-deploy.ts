// Step 2: deploy ReactiveHitHandler from the funded key generated in step 1.
// Refuses to run until the deployer address holds at least 32 SOMI (the
// reactive-subscription-owner floor) plus a small gas cushion.
//
//   npx tsx src/02-deploy.ts

import "dotenv/config";
import { writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatEther, parseEther } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { compileHandler } from "./compile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../.env");

const REQUIRED_BALANCE = parseEther("32.05"); // 32 SOMI floor + a small gas cushion

async function main(): Promise<void> {
  const ctx = createChainContext();
  const balance = await ctx.publicClient.getBalance({ address: ctx.account.address });

  console.log(`deployer : ${ctx.account.address}`);
  console.log(`network  : ${ctx.net.name} (chain ${ctx.net.chainId})`);
  console.log(`balance  : ${formatEther(balance)} ${ctx.net.nativeSymbol}`);

  if (balance < REQUIRED_BALANCE) {
    console.log(`\nNot funded yet. Need at least ${formatEther(REQUIRED_BALANCE)} ${ctx.net.nativeSymbol}.`);
    console.log("Fund the deployer address above, then re-run this script.");
    process.exit(1);
  }

  const { abi, bytecode } = compileHandler();
  console.log(`\ncontract compiled OK (bytecode ${bytecode.length} chars)`);

  const hash = await ctx.walletClient.deployContract({
    abi,
    bytecode,
    account: ctx.account,
    chain: ctx.walletClient.chain,
  });
  console.log(`deploy tx: ${hash}`);

  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`deployment failed: status=${receipt.status}`);
  }

  console.log(`deployed at: ${receipt.contractAddress}`);
  console.log(`gas used: ${receipt.gasUsed}`);

  const line = `HANDLER_ADDRESS=${receipt.contractAddress}\n`;
  if (existsSync(envPath) && readFileSync(envPath, "utf8").includes("HANDLER_ADDRESS=")) {
    console.log("HANDLER_ADDRESS already set in .env - not overwriting. Delete it manually if you want to redeploy.");
  } else {
    appendFileSync(envPath, line);
    console.log("Wrote HANDLER_ADDRESS to .env");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
