import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, MARKET_STATUS } from "@dreamdex-bot-kit/ec-core";

const MARKET_ID = "0x00000000000000000000000000000000000000000000000000000000000046fe" as `0x${string}`;

const ecCtx = createExchange({ withSigner: false });
const onchain = await ecCtx.exchange.client.getMarketOnchain(MARKET_ID);
console.log(JSON.stringify(onchain, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
const statusName = Object.keys(MARKET_STATUS).find((k) => MARKET_STATUS[k as keyof typeof MARKET_STATUS] === onchain?.status);
console.log(`status: ${statusName}`);
const nowSec = Math.floor(Date.now() / 1000);
console.log(`now: ${nowSec}, expiry: ${onchain?.expiry}, diff: ${Number(onchain?.expiry ?? 0n) - nowSec}s`);
