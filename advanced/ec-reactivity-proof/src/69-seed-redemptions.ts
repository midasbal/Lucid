// One-off, real: redeem a handful of this project's own real, already-
// finalized, never-redeemed positions (found live via the indexer's own
// OutcomeBalance table) so the app's new portfolio History view has real
// RedemptionRecord rows to prove against. Every position here already
// belongs to this project's own funded testnet EOA from earlier chunks of
// work; nothing new is opened, only real, existing, unclaimed balances are
// closed out. See PORTFOLIO.md for the full account.
import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange } from "@dreamdex-bot-kit/ec-core";

const ctx = createChainContext();
const exchange = createExchange({ withSigner: true });

// (marketId, outcomeIdx, expected label) picked live from OutcomeBalance:
// two winners, two losers, deliberately, so the portfolio's won/lost
// labeling has a real example of each.
const TARGETS: Array<{ marketId: `0x${string}`; outcomeIdx: 0 | 1; label: string }> = [
  { marketId: "0x0000000000000000000000000000000000000000000000000000000000004c66", outcomeIdx: 0, label: "ETH ...4c66 YES (won, winningOutcome=0)" },
  { marketId: "0x0000000000000000000000000000000000000000000000000000000000004c66", outcomeIdx: 1, label: "ETH ...4c66 NO (lost, winningOutcome=0)" },
  { marketId: "0x0000000000000000000000000000000000000000000000000000000000005b7d", outcomeIdx: 0, label: "BTC ...5b7d YES (lost, winningOutcome=1)" },
  { marketId: "0x0000000000000000000000000000000000000000000000000000000000005de7", outcomeIdx: 0, label: "BTC ...5de7 YES (won, winningOutcome=0)" },
];

async function main() {
  for (const t of TARGETS) {
    console.log(`\n=== ${t.label} ===`);
    const onchain = await exchange.exchange.client.getMarketOnchain(t.marketId);
    const balance = await exchange.exchange.client.getOutcomeBalance({
      outcomeToken: onchain.outcomeToken,
      account: ctx.account.address,
      id: t.outcomeIdx === 0 ? onchain.yesId : onchain.noId,
    });
    console.log(`held: ${balance} raw, resolved=${onchain.isResolved} voided=${onchain.isVoided} winningOutcome=${onchain.winningOutcome}`);
    if (balance <= 0n) {
      console.log("nothing held, skipping");
      continue;
    }
    const res = await exchange.exchange.trader.redeem({
      marketId: t.marketId,
      market: onchain.marketAddress,
      outcomeToken: onchain.outcomeToken,
      outcomeIdx: t.outcomeIdx,
      amount: balance,
    });
    console.log(`redeem tx: ${res.hash} status: ${res.status}`);
  }
  await exchange.exchange.close();
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
