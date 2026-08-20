// Isolation test: does placeBinaryOrderFor work at all when the OWNER calls
// it on themselves (owner param == msg.sender)? If yes, the revert seen from
// the operator is specifically about operator identity, not a broken or
// differently-gated function. If it also reverts here, the 0x3fb0ba2e error
// is unrelated to delegation entirely.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAbi } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, loadConfig, marketOnchain, activeMarkets, resolveVenue, outcomeSymbols, MARKET_STATUS, shutdown } from "@dreamdex-bot-kit/ec-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function readEnvKey(file: string, varName: string): `0x${string}` {
  const content = readFileSync(path.resolve(__dirname, "..", file), "utf8");
  const match = content.match(new RegExp(`${varName}=(0x[0-9a-fA-F]+)`));
  if (!match) throw new Error(`${varName} not found`);
  return match[1] as `0x${string}`;
}
const OWNER_KEY = readEnvKey(".env", "PRIVATE_KEY");

const TARGET_MARKET_ID = ("0x" + "4712".padStart(64, "0")) as `0x${string}`;
const BOOK_PARAMS_ABI = parseAbi(["function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))"]);
const POOL_WRITE_ABI = parseAbi([
  "function placeBinaryOrderFor(address owner, uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool success, uint128 id)",
  "function cancelOrder(uint128 orderId)",
]);

async function main(): Promise<void> {
  const ownerCtx = createChainContext(OWNER_KEY);
  const cfg = loadConfig();
  const ecCtx = createExchange({ withSigner: false });
  await ecCtx.exchange.loadMarkets(true);
  await resolveVenue(ecCtx);
  const markets = await activeMarkets(ecCtx, { max: 1e6 });
  const market = markets.find((m) => m.info.marketType === "BINARY" && m.info.marketId.toLowerCase() === TARGET_MARKET_ID.toLowerCase());
  if (!market) throw new Error("market not active");
  const onchain = await marketOnchain(ecCtx, market);
  if (!onchain || onchain.status !== MARKET_STATUS.Trading) throw new Error("not trading");

  const params = await ownerCtx.publicClient.readContract({ address: onchain.pool, abi: BOOK_PARAMS_ABI, functionName: "getOrderBookParameters" });
  const one = 10n ** BigInt(cfg.decimals);

  const { yes } = outcomeSymbols(market);
  const book = await ecCtx.exchange.fetchOrderBook(yes, 5);
  const bestBid = book.bids[0]?.[0];
  if (bestBid === undefined) throw new Error("no bids");
  const tickHuman = Number(params.tickSize) / Number(one);
  const restPriceHuman = Math.max(bestBid - 3 * tickHuman, tickHuman);
  const restPriceRaw = BigInt(Math.round(restPriceHuman * Number(one)));
  const sizeHuman = 3 / restPriceHuman;
  const quantityRaw = (BigInt(Math.floor(sizeHuman * Number(one))) / params.lotSize) * params.lotSize;
  const expireNs = BigInt(Math.floor(Date.now() / 1000) + 300) * 1_000_000_000n;

  console.log(`owner calling placeBinaryOrderFor(owner=self) directly...`);
  console.log(`price=${restPriceRaw} quantity=${quantityRaw}`);

  try {
    const hash = await ownerCtx.walletClient.writeContract({
      address: onchain.pool,
      abi: POOL_WRITE_ABI,
      functionName: "placeBinaryOrderFor",
      args: [ownerCtx.account.address, 0, restPriceRaw, quantityRaw, expireNs, 3, 0, "0x0000000000000000000000000000000000000000", 0n, 0n],
      account: ownerCtx.account,
      chain: ownerCtx.walletClient.chain,
    });
    console.log(`tx: ${hash}`);
    const receipt = await ownerCtx.publicClient.waitForTransactionReceipt({ hash });
    console.log(`status: ${receipt.status}, gas used: ${receipt.gasUsed}`);

    if (receipt.status === "success") {
      await new Promise((r) => setTimeout(r, 2000));
      const open = await ecCtx.exchange.fetchOpenOrders(yes);
      console.log(`open orders: ${open.length}`);
      const ours = open.find((o) => o.price === restPriceHuman);
      if (ours) {
        console.log(`cancelling orderId ${ours.id}...`);
        const cancelHash = await ownerCtx.walletClient.writeContract({
          address: onchain.pool,
          abi: POOL_WRITE_ABI,
          functionName: "cancelOrder",
          args: [BigInt(ours.id)],
          account: ownerCtx.account,
          chain: ownerCtx.walletClient.chain,
        });
        console.log(`cancel tx: ${cancelHash}`);
        await ownerCtx.publicClient.waitForTransactionReceipt({ hash: cancelHash });
        console.log("cancelled.");
      }
    }
  } catch (e) {
    console.log(`FAILED: ${(e as Error).message}`);
  }

  await shutdown(ecCtx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
