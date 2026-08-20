import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, loadConfig } from "@dreamdex-bot-kit/ec-core";
import { toHuman } from "@somnia-chain/markets-sdk";

const MARKET_ID = "0x00000000000000000000000000000000000000000000000000000000000046f1" as `0x${string}`;

const ctx = createChainContext();
const cfg = loadConfig();
const ecCtx = createExchange({ withSigner: false });
const onchain = await ecCtx.exchange.client.getMarketOnchain(MARKET_ID);
if (!onchain) throw new Error("no onchain snapshot");

const yesBal = await ecCtx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: ctx.account.address, id: onchain.yesId });
const noBal = await ecCtx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: ctx.account.address, id: onchain.noId });
const collateral = cfg.addresses.collateral ?? cfg.addresses.testUsdc!;
const tusdcBal = await ecCtx.exchange.client.getErc20Balance(collateral, ctx.account.address);

console.log(`YES balance (raw ${onchain.yesId}): ${yesBal} (${toHuman(yesBal, cfg.decimals)})`);
console.log(`NO balance  (raw ${onchain.noId}): ${noBal} (${toHuman(noBal, cfg.decimals)})`);
console.log(`tUSDC balance: ${toHuman(tusdcBal, cfg.decimals)}`);
