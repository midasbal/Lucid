// Step 1: fund the trading EOA with test USDC via the faucet, report both
// balances. Same EOA used throughout this proof (already holds STT gas).
import "dotenv/config";
import { formatEther } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, loadConfig, shutdown } from "@dreamdex-bot-kit/ec-core";
import { toHuman } from "@somnia-chain/markets-sdk";

async function main(): Promise<void> {
  const ctx = createChainContext();
  const cfg = loadConfig();
  const address = ctx.account.address;

  const nativeBal = await ctx.publicClient.getBalance({ address });
  console.log(`account : ${address}`);
  console.log(`network : ${cfg.network} (chain ${cfg.chainId})`);
  console.log(`STT gas : ${formatEther(nativeBal)} STT`);

  const ecCtx = createExchange({ withSigner: true });
  const collateral = cfg.addresses.collateral ?? cfg.addresses.testUsdc;
  if (!collateral) throw new Error("no collateral/testUsdc address resolved from ec-core config");

  const before = await ecCtx.exchange.client.getErc20Balance(collateral, address);
  console.log(`\ntUSDC before faucet: ${toHuman(before, cfg.decimals)}`);

  const res = await ecCtx.exchange.trader.faucet();
  console.log(`faucet tx: ${res.hash}`);
  console.log(`status: ${res.receipt?.status}`);

  await new Promise((r) => setTimeout(r, 2000));
  const after = await ecCtx.exchange.client.getErc20Balance(collateral, address);
  console.log(`\ntUSDC after faucet: ${toHuman(after, cfg.decimals)}`);
  console.log(`collateral address (live-resolved): ${collateral}`);

  await shutdown(ecCtx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
