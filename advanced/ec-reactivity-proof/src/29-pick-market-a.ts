import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, resolveVenue, activeMarkets, marketOnchain, MARKET_STATUS, shutdown } from "@dreamdex-bot-kit/ec-core";

async function main(): Promise<void> {
  createChainContext();
  const ecCtx = createExchange({ withSigner: false });
  await ecCtx.exchange.loadMarkets(true);
  await resolveVenue(ecCtx);

  const markets = await activeMarkets(ecCtx, { max: 1e6 });
  const rows: { symbol: string; marketId: string; ttlMin: number }[] = [];
  for (const m of markets) {
    if (m.info.marketType !== "BINARY") continue;
    const onchain = await marketOnchain(ecCtx, m);
    if (!onchain || onchain.status !== MARKET_STATUS.Trading) continue;
    const ttlMin = (Number(onchain.expiry) - Date.now() / 1000) / 60;
    rows.push({ symbol: m.symbol, marketId: m.info.marketId, ttlMin });
  }
  rows.sort((a, b) => b.ttlMin - a.ttlMin);
  for (const r of rows) console.log(`${r.symbol}  ttl=${r.ttlMin.toFixed(1)}min  ${r.marketId}`);

  await shutdown(ecCtx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
