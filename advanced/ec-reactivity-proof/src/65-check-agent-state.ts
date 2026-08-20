import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, loadConfig, marketOnchain, activeMarkets } from "@dreamdex-bot-kit/ec-core";
import { parseAbi } from "viem";
import { toHuman as sdkToHuman } from "@somnia-chain/markets-sdk";

const AGENT = (process.env.CHECK_AGENT ?? "0x1c2224c0e69482c95c4cfbfa587211d3e0e70e6c") as `0x${string}`;
const MARKET_SYMBOL = process.env.CHECK_MARKET ?? "BTC-0-20AUG26-2000-4CFF/tUSDC";

const ctx = createChainContext();
const cfg = loadConfig();
const collateral = cfg.addresses.collateral ?? cfg.addresses.testUsdc!;
const ecCtx = createExchange({ withSigner: false });
const bal = await ecCtx.exchange.client.getErc20Balance(collateral, AGENT);
console.log(`agent tUSDC balance: ${sdkToHuman(bal, cfg.decimals)} (raw ${bal})`);

const markets = await activeMarkets(ecCtx, { max: 1e6 });
const m = markets.find((x) => x.symbol === MARKET_SYMBOL);
if (m) {
  const onchain = await marketOnchain(ecCtx, m);
  if (onchain) {
    const yesBal = await ecCtx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: AGENT, id: onchain.yesId });
    const noBal = await ecCtx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: AGENT, id: onchain.noId });
    console.log(`agent YES balance: ${yesBal}, NO balance: ${noBal}`);
  }
}

const GATE_ABI = parseAbi([
  "function bidOrderId() view returns (uint128)",
  "function askOrderId() view returns (uint128)",
]);
const bidId = await ctx.publicClient.readContract({ address: AGENT, abi: GATE_ABI, functionName: "bidOrderId" });
const askId = await ctx.publicClient.readContract({ address: AGENT, abi: GATE_ABI, functionName: "askOrderId" });
console.log(`tracked bidOrderId=${bidId} askOrderId=${askId}`);
process.exit(0);
