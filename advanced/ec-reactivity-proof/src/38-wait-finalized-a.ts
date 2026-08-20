// Waits until market A (Phase A's gate market) shows finalized: true, then
// exits. No narration of raw counters, just the terminal state.
import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";

const MARKET_ID = "0x00000000000000000000000000000000000000000000000000000000000046fe" as `0x${string}`;
const POLL_MS = 30_000;
const TIMEOUT_MS = 70 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const ctx = createChainContext();
  const { createExchange } = await import("@dreamdex-bot-kit/ec-core");
  const ecCtx = createExchange({ withSigner: false });

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const onchain = await ecCtx.exchange.client.getMarketOnchain(MARKET_ID);
    if (onchain?.finalized) {
      console.log(`FINALIZED. status=${onchain.status} winningOutcome=${onchain.winningOutcome} isVoided=${onchain.isVoided}`);
      return;
    }
    await sleep(POLL_MS);
  }
  console.log("TIMEOUT: market did not finalize within the wait window.");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
