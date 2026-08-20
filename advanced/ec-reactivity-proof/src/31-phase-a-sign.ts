// Phase A step 2: sign a RedeemAuthorization for each side via
// Trader.signRedeemAuth, owner = our EOA. Prints both structs and signatures.
import "dotenv/config";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange } from "@dreamdex-bot-kit/ec-core";
import { marketKey } from "@somnia-chain/markets-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MARKET_ID = "0x00000000000000000000000000000000000000000000000000000000000046fe" as `0x${string}`;
const YES_ID = 5068097350466123602613906970650487541946681902180214871155383268803584n;
const NO_ID = 5068097350466123602613906970650487541946681902180214871155383268803585n;
const YES_AMOUNT = 6802000n;
const NO_AMOUNT = 4777000n;

function jsonSafe(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val)));
}

async function main(): Promise<void> {
  const ctx = createChainContext();
  const ecCtx = createExchange({ withSigner: true });

  const key = marketKey(YES_ID);
  console.log(`marketKey (from yesId, per ids.ts): ${key}`);
  console.log(`marketKey (from noId, should match): ${marketKey(NO_ID)}`);

  const nowSec = Math.floor(Date.now() / 1000);
  const deadline = BigInt(nowSec + 2 * 60 * 60); // +2h, well past this market's resolution
  const baseNonce = BigInt(Date.now()) * 1000n;

  const yesAuth = await ecCtx.exchange.trader.signRedeemAuth({
    marketId: MARKET_ID,
    outcomeIdx: 0,
    amount: YES_AMOUNT,
    nonce: baseNonce + 1n,
    deadline,
  });
  console.log(`\nYES authorization:`);
  console.log(JSON.stringify(jsonSafe(yesAuth), null, 2));

  const noAuth = await ecCtx.exchange.trader.signRedeemAuth({
    marketId: MARKET_ID,
    outcomeIdx: 1,
    amount: NO_AMOUNT,
    nonce: baseNonce + 2n,
    deadline,
  });
  console.log(`\nNO authorization:`);
  console.log(JSON.stringify(jsonSafe(noAuth), null, 2));

  const outPath = path.resolve(__dirname, "../phase-a-auths.json");
  writeFileSync(
    outPath,
    JSON.stringify({ marketKey: key.toString(), marketId: MARKET_ID, owner: ctx.account.address, yesAuth: jsonSafe(yesAuth), noAuth: jsonSafe(noAuth) }, null, 2),
  );
  console.log(`\nwrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
