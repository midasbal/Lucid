// Phase A step 3: generate a separate relayer key, fund it with a little
// STT for gas only (no reactive-subscription floor needed here, the relayer
// just submits one transaction). Funded directly from our main EOA's STT
// balance, no faucet needed for native gas.
import "dotenv/config";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEther, formatEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createChainContext } from "@dreamdex-bot-kit/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAYER_ENV_PATH = path.resolve(__dirname, "../.env.relayer");

const FUND_AMOUNT = parseEther("1"); // small, gas only

async function main(): Promise<void> {
  const ctx = createChainContext();

  const relayerKey = generatePrivateKey();
  const relayerAddress = privateKeyToAccount(relayerKey).address;
  console.log(`relayer address: ${relayerAddress}`);

  writeFileSync(RELAYER_ENV_PATH, `RELAYER_PRIVATE_KEY=${relayerKey}\n`, { mode: 0o600 });

  const ownerBalBefore = await ctx.publicClient.getBalance({ address: ctx.account.address });
  console.log(`owner STT balance before funding relayer: ${formatEther(ownerBalBefore)}`);

  const hash = await ctx.walletClient.sendTransaction({ account: ctx.account, chain: ctx.walletClient.chain, to: relayerAddress, value: FUND_AMOUNT });
  console.log(`funding tx: ${hash}`);
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  console.log(`status: ${receipt.status}`);

  const relayerBal = await ctx.publicClient.getBalance({ address: relayerAddress });
  const ownerBalAfter = await ctx.publicClient.getBalance({ address: ctx.account.address });
  console.log(`\nrelayer STT balance: ${formatEther(relayerBal)}`);
  console.log(`owner STT balance after: ${formatEther(ownerBalAfter)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
