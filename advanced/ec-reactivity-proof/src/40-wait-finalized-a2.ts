import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange } from "@dreamdex-bot-kit/ec-core";

const MARKET_ID = "0x0000000000000000000000000000000000000000000000000000000000004702" as `0x${string}`;
const POLL_MS = 15_000;
const TIMEOUT_MS = 20 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  createChainContext();
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
  console.log("TIMEOUT");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
