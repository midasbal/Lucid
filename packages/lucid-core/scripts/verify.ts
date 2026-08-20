// Headless proof that lucid-core is real: every function below hits live
// Shannon testnet (chain 50312). No mocks, no stubs. Run with `npm run verify`.
//
// Two signers:
//   - MAKER_KEY: the maker's own local private key (strategies/lucid-maker/.env),
//     drives the privateKey-context path, how the maker runs.
//   - APP_KEY: a second, separate wallet (advanced/ec-reactivity-proof/.env.relayer),
//     wrapped in a real viem WalletClient this library never sees the key of,
//     drives the walletClient-context path, standing in for a browser wallet.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toHuman } from "@somnia-chain/markets-sdk";
import { loadConfig, loadEnv, makeChain, seedInventory, shutdown } from "@dreamdex-bot-kit/ec-core";
import {
  createLucidContext,
  createReadOnlyContext,
  listLiveMarkets,
  resolveMarket,
  getMarketDefinition,
  getOrderBook,
  getAccountPosition,
  getNetPosition,
  getFairValueWithBook,
  submitOrder,
  cancelOrder,
  enrollAutoRedeem,
} from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readEnvKey(file: string, varName: string): `0x${string}` {
  const content = readFileSync(path.resolve(__dirname, "..", "..", "..", file), "utf8");
  const match = content.match(new RegExp(`${varName}=(0x[0-9a-fA-F]+)`));
  if (!match) throw new Error(`${varName} not found in ${file}`);
  return match[1] as `0x${string}`;
}

const MAKER_KEY = readEnvKey("strategies/lucid-maker/.env", "PRIVATE_KEY");
const APP_KEY = readEnvKey("advanced/ec-reactivity-proof/.env.relayer", "RELAYER_PRIVATE_KEY");

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
  loadEnv();
  const config = loadConfig();

  section("1. MARKET DATA (read-only context)");
  const roCtx = createReadOnlyContext();
  const live = await listLiveMarkets(roCtx);
  console.log(`${live.length} live Trading markets`);
  for (const m of live.slice(0, 5)) console.log(`  ${m.symbol}  ttl=${Math.round(m.ttlSec)}s`);
  const firstLive = live[0];
  if (!firstLive) throw new Error("no live Trading markets to verify against");

  const { market: target, onchain } = await resolveMarket(roCtx, firstLive.symbol);

  const definition = await getMarketDefinition(roCtx, target);
  console.log(`\npicked: ${definition.symbol}`);
  console.log(`  asset=${definition.asset} expiry=${definition.expiry} pool=${definition.pool}`);
  console.log(`  yesId=${definition.yesId} noId=${definition.noId} decimals=${definition.decimals}`);
  console.log(`  live tick=${definition.tickSize} lot=${definition.lotSize} minQty=${definition.minQuantity}`);
  console.log(`  openingPrice=${definition.openingPrice}`);

  const book = await getOrderBook(roCtx, target);
  console.log(`  book: bestBid=${book.bestBid} bestAsk=${book.bestAsk} spread=${book.spread}`);

  const makerAccount = privateKeyToAccount(MAKER_KEY);
  const makerPosition = await getAccountPosition(roCtx, onchain, makerAccount.address);
  console.log(`  maker (${makerAccount.address}) position: YES=${makerPosition.yesBalance} NO=${makerPosition.noBalance} net=${makerPosition.netPosition}`);

  section("2. PRICING (model-fair YES alongside the live book)");
  const fv = await getFairValueWithBook(roCtx, target, { fallbackVolatility: 0.6 });
  console.log(`  spot=${fv.spot} vol=${fv.volatility.toFixed(4)} (${fv.volatilitySource}) fairYes=${fv.fairYes.toFixed(4)}`);
  if (fv.edgeVsMid !== undefined) console.log(`  edge vs book mid: ${fv.edgeVsMid.toFixed(4)}`);

  section("3a. TRADE BUILDING: local privateKey signer (the maker)");
  const makerCtx = createLucidContext({ privateKey: MAKER_KEY });
  console.log(`  signerKind=${makerCtx.signerKind} canTrade=${makerCtx.canTrade}`);
  const restBid = Math.max(0.01, (book.bestBid ?? 0.5) - 0.1);
  const makerOrder = await submitOrder(makerCtx, {
    market: target,
    onchain,
    outcome: "YES",
    side: "buy",
    price: restBid,
    size: definition.lotSize > 0n ? Number(definition.lotSize) / 10 ** definition.decimals : 1,
    type: "post-only",
  });
  console.log(`  placed: orderId=${makerOrder.orderId} price=${makerOrder.price} size=${makerOrder.size} hash=${makerOrder.hash}`);
  if (!makerOrder.orderId) throw new Error("maker post-only order did not rest, nothing to cancel");
  const makerCancel = await cancelOrder(makerCtx, onchain, makerOrder.orderId);
  console.log(`  cancelled: hash=${makerCancel.hash}`);

  section("3b. TRADE BUILDING: external viem WalletClient signer (app-user stand-in)");
  const appAccount = privateKeyToAccount(APP_KEY);
  const appWalletClient = createWalletClient({ account: appAccount, chain: makeChain(config), transport: http(config.rpcUrl) }).extend(publicActions);
  const appCtx = createLucidContext({ walletClient: appWalletClient });
  console.log(`  signerKind=${appCtx.signerKind} canTrade=${appCtx.canTrade} address=${appAccount.address}`);
  await appCtx.exchange.loadMarkets(true);

  const smallInventoryConfig = { ...appCtx.config, inventory: 1 };
  const appCtxSmall = { ...appCtx, config: smallInventoryConfig };
  console.log(`  seeding app wallet: faucet collateral + mint a small YES/NO set...`);
  await seedInventory(appCtxSmall as never, target, onchain);

  const appOrder = await submitOrder(appCtx, {
    market: target,
    onchain,
    outcome: "YES",
    side: "buy",
    price: restBid,
    size: definition.lotSize > 0n ? Number(definition.lotSize) / 10 ** definition.decimals : 1,
    type: "post-only",
  });
  console.log(`  placed: orderId=${appOrder.orderId} price=${appOrder.price} size=${appOrder.size} hash=${appOrder.hash}`);
  if (!appOrder.orderId) throw new Error("app post-only order did not rest, nothing to cancel");
  const appCancel = await cancelOrder(appCtx, onchain, appOrder.orderId);
  console.log(`  cancelled: hash=${appCancel.hash}`);

  section("4. AUTO-REDEEM ENROLLMENT: external wallet enrolls a real position");
  const handlerAddress = readEnvKey("advanced/ec-reactivity-proof/.env", "HERO_HANDLER_ADDRESS");
  console.log(`  handler=${handlerAddress}`);

  const appYesBal = await appCtx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: appAccount.address, id: onchain.yesId });
  console.log(`  app wallet YES balance: ${toHuman(appYesBal, definition.decimals)} (raw ${appYesBal})`);
  if (appYesBal <= 0n) throw new Error("mint did not produce a YES balance to enroll");

  const enrollment = await enrollAutoRedeem(appCtx, appWalletClient, {
    handlerAddress,
    marketId: definition.marketId,
    onchain,
    outcomeIdx: 0,
    amount: appYesBal,
  });
  console.log(`  registered: marketKeyValue=${enrollment.marketKeyValue} nonce=${enrollment.nonce} deadline=${enrollment.deadline}`);
  console.log(`  registerAuth tx: ${enrollment.registerTxHash}`);

  const finalNet = await getNetPosition(makerCtx, onchain);
  console.log(`\nmaker net position on ${definition.symbol}: ${finalNet}`);

  section("DONE");
  console.log("all live, all real, small sizes throughout.");

  // Each context built its own SomniaMarkets instance with its own open
  // websocket/http handles; none of them close on their own, and close()
  // alone still leaves this a one-shot script hanging on some other open
  // handle, so exit explicitly once everything above has printed.
  await Promise.all([shutdown(roCtx as never), shutdown(makerCtx as never), shutdown(appCtx as never)]);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
