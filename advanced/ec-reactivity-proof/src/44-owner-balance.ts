import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, loadConfig } from "@dreamdex-bot-kit/ec-core";
import { toHuman } from "@somnia-chain/markets-sdk";

const ctx = createChainContext();
const cfg = loadConfig();
const ecCtx = createExchange({ withSigner: false });
const collateral = cfg.addresses.collateral ?? cfg.addresses.testUsdc!;
const bal = await ecCtx.exchange.client.getErc20Balance(collateral, ctx.account.address);
console.log(`owner tUSDC: ${toHuman(bal, cfg.decimals)} (raw ${bal})`);
