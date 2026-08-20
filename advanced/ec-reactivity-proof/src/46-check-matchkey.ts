import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange } from "@dreamdex-bot-kit/ec-core";
import { marketKey } from "@somnia-chain/markets-sdk";

const HANDLER_ABI = [
  {
    type: "function",
    name: "auths",
    stateMutability: "view",
    inputs: [
      { name: "", type: "uint256" },
      { name: "", type: "uint256" },
    ],
    outputs: [
      { name: "owner", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "sig", type: "bytes" },
      { name: "operatorId", type: "uint32" },
      { name: "venueId", type: "bytes32" },
      { name: "marketId", type: "bytes32" },
      { name: "redeemed", type: "bool" },
    ],
  },
] as const;

async function main(): Promise<void> {
  const ctx = createChainContext();
  const handlerAddress = process.env.HERO_HANDLER_ADDRESS as `0x${string}`;
  const ecCtx = createExchange({ withSigner: false });

  // Recompute marketKey independently, live, from the market's current
  // on-chain pool + nonce (the same values that will be baked into the
  // real MarketFinalized event's topics[1] when it fires).
  const properMarketId = ("0x" + "4707".padStart(64, "0")) as `0x${string}`;
  console.log(`marketId built: ${properMarketId} (length ${properMarketId.length})`);
  const onchain = await ecCtx.exchange.client.getMarketOnchain(properMarketId);
  if (!onchain) throw new Error("no onchain snapshot for this market");

  console.log(`market pool: ${onchain.pool}, nonce: ${onchain.nonce}`);
  const computedKeyFromYesId = marketKey(onchain.yesId);
  const computedKeyFromNoId = marketKey(onchain.noId);
  console.log(`marketKey (from live yesId): ${computedKeyFromYesId}`);
  console.log(`marketKey (from live noId):  ${computedKeyFromNoId}`);
  console.log(`match: ${computedKeyFromYesId === computedKeyFromNoId}`);

  const registeredKey = 2040732934468698939554459975902734157505744126128863482567259586562n;
  console.log(`\nkey used at registration time: ${registeredKey}`);
  console.log(`matches live-recomputed key: ${registeredKey === computedKeyFromYesId}`);

  // What the real event's topics[1] will actually carry is uint256(marketKey)
  // as a bytes32 topic - confirm the packed pool+nonce composition directly
  // too, independent of the SDK helper, as a second, from-scratch check.
  const packed = (BigInt(onchain.pool) << 64n) | onchain.nonce;
  console.log(`\nindependently packed (pool << 64 | nonce): ${packed}`);
  console.log(`matches SDK marketKey helper: ${packed === computedKeyFromYesId}`);

  console.log(`\n=== Handler storage lookup ===`);
  const yesAuth = await ctx.publicClient.readContract({ address: handlerAddress, abi: HANDLER_ABI, functionName: "auths", args: [registeredKey, 0n] });
  const noAuth = await ctx.publicClient.readContract({ address: handlerAddress, abi: HANDLER_ABI, functionName: "auths", args: [registeredKey, 1n] });

  console.log(`auths[marketKey][0] (YES): owner=${yesAuth[0]} amount=${yesAuth[1]} marketId=${yesAuth[7]} redeemed=${yesAuth[8]}`);
  console.log(`auths[marketKey][1] (NO):  owner=${noAuth[0]} amount=${noAuth[1]} marketId=${noAuth[7]} redeemed=${noAuth[8]}`);

  const registered = yesAuth[0] !== "0x0000000000000000000000000000000000000000" && noAuth[0] !== "0x0000000000000000000000000000000000000000";
  console.log(`\nboth auths present at the key onEvent will actually look up: ${registered}`);
  console.log(`stored marketId matches the market's real bytes32 id: YES=${yesAuth[7] === properMarketId}, NO=${noAuth[7] === properMarketId}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
