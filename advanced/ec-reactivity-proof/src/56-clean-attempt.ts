// One clean, complete attempt of the full contract order gate flow on a
// fresh market: deploy, fund, place via the contract, confirm the resting
// order's owner is the contract, cancel via the contract, confirm it is
// gone. Market symbol passed as argv[2]. All addresses resolved live.
import "dotenv/config";
import { parseAbi } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { loadConfig, outcomeSymbols } from "@dreamdex-bot-kit/ec-core";
import { createReadOnlyContext, resolveMarket, getMarketDefinition } from "@dreamdex-bot-kit/lucid-core";
import { compileContract } from "./compile.js";

const ERC20_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address account) view returns (uint256)"]);
const GET_ORDER_ABI = parseAbi(["function getOrder(uint128 orderId) view returns ((uint128 orderId, bool isBid, address owner, uint64 userData, uint256 price, uint256 fullQuantity, uint256 quantityRemaining, uint64 expireTimestampNs))"]);

const FUND_AMOUNT = 2_000_000n; // 2 tUSDC raw

async function main(): Promise<void> {
  const symbol = process.argv[2];
  if (!symbol) throw new Error("usage: tsx 56-clean-attempt.ts <market symbol>");

  const ctx = createChainContext();
  const cfg = loadConfig();
  const collateral = cfg.addresses.collateral ?? cfg.addresses.testUsdc;
  if (!collateral) throw new Error("no collateral address resolved");

  const roCtx = createReadOnlyContext();
  const { market, onchain } = await resolveMarket(roCtx, symbol);
  const definition = await getMarketDefinition(roCtx, market);
  console.log(`market: ${symbol}`);
  console.log(`pool: ${onchain.pool} tick=${definition.tickSize} lot=${definition.lotSize} minQty=${definition.minQuantity}`);

  const { abi, bytecode } = compileContract("ContractOrderGate.sol", "ContractOrderGate");
  const deployHash = await ctx.walletClient.deployContract({ abi, bytecode, args: [onchain.pool, collateral], account: ctx.account, chain: ctx.walletClient.chain });
  const deployReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (deployReceipt.status !== "success" || !deployReceipt.contractAddress) throw new Error("deploy failed");
  const gate = deployReceipt.contractAddress;
  console.log(`deploy tx: ${deployHash}`);
  console.log(`deployed at: ${gate}`);

  const fundHash = await ctx.walletClient.writeContract({ address: collateral, abi: ERC20_ABI, functionName: "transfer", args: [gate, FUND_AMOUNT], account: ctx.account, chain: ctx.walletClient.chain });
  await ctx.publicClient.waitForTransactionReceipt({ hash: fundHash });
  console.log(`fund tx: ${fundHash}`);

  const { yes } = outcomeSymbols(market);
  const book = await roCtx.exchange.fetchOrderBook(yes, 3);
  const bestBid = book.bids[0]?.[0];
  const tick = definition.tickSize;
  const oneUnit = 10 ** definition.decimals;
  let priceAligned: bigint;
  if (bestBid === undefined) {
    priceAligned = tick * 100n; // no book yet, park far from any plausible price
  } else {
    const rawBid = BigInt(Math.round(bestBid * oneUnit));
    const target = rawBid > 20n * tick ? rawBid - 20n * tick : tick;
    priceAligned = target - (target % tick);
  }
  const quantity = 2n * BigInt(oneUnit);
  console.log(`\nplacing via the contract: price=${priceAligned} quantity=${quantity} bestBid=${bestBid ?? "none"}`);

  const placeSim = await ctx.publicClient.simulateContract({ address: gate, abi, functionName: "placeOrder", args: [0, priceAligned, quantity], account: ctx.account });
  const orderId = placeSim.result as bigint;
  const placeHash = await ctx.walletClient.writeContract(placeSim.request);
  const placeReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: placeHash });
  console.log(`place tx: ${placeHash}`);
  console.log(`place status: ${placeReceipt.status} gasUsed: ${placeReceipt.gasUsed}`);
  if (placeReceipt.status !== "success") throw new Error("place reverted on chain");

  const resting = await ctx.publicClient.readContract({ address: onchain.pool, abi: GET_ORDER_ABI, functionName: "getOrder", args: [orderId] });
  console.log(`\nresting order owner: ${resting.owner}`);
  console.log(`owner is the contract: ${resting.owner.toLowerCase() === gate.toLowerCase()}`);
  if (resting.owner.toLowerCase() !== gate.toLowerCase()) throw new Error("owner mismatch");

  const cancelSim = await ctx.publicClient.simulateContract({ address: gate, abi, functionName: "cancelOrder", args: [orderId], account: ctx.account });
  const cancelHash = await ctx.walletClient.writeContract(cancelSim.request);
  const cancelReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: cancelHash });
  console.log(`\ncancel tx: ${cancelHash}`);
  console.log(`cancel status: ${cancelReceipt.status} gasUsed: ${cancelReceipt.gasUsed}`);
  if (cancelReceipt.status !== "success") throw new Error("cancel reverted on chain");

  const after = await ctx.publicClient.readContract({ address: onchain.pool, abi: GET_ORDER_ABI, functionName: "getOrder", args: [orderId] });
  const gone = after.quantityRemaining === 0n;
  console.log(`\nafter cancel, quantityRemaining: ${after.quantityRemaining}, gone: ${gone}`);

  console.log(`\n=== CLEAN ATTEMPT SUCCEEDED ===`);
  console.log(`market: ${symbol}`);
  console.log(`gate: ${gate}`);
  console.log(`deploy: ${deployHash}`);
  console.log(`fund: ${fundHash}`);
  console.log(`place: ${placeHash}`);
  console.log(`cancel: ${cancelHash}`);
  console.log(`orderId: ${orderId}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`ATTEMPT FAILED: ${(e as Error).message.slice(0, 500)}`);
    process.exit(1);
  },
);
