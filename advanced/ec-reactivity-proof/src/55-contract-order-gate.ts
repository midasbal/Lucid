// Decisive gate: can a deployed contract place and cancel a binary order on
// an event-contract pool while holding its own collateral? The ABI has no
// caller-type guard (MAKER-GATE.md), but every order in this project has
// come from an EOA. Deploy ContractOrderGate, fund it with a little tUSDC,
// have it place one small post-only order a few ticks off best on a live
// market, confirm the resting order's owner is the contract address, then
// have it cancel, and confirm the order is gone. All markets and addresses
// resolved live at run time.
import "dotenv/config";
import { parseAbi } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { loadConfig, outcomeSymbols } from "@dreamdex-bot-kit/ec-core";
import { createReadOnlyContext, listLiveMarkets, resolveMarket, getMarketDefinition } from "@dreamdex-bot-kit/lucid-core";
import { compileContract } from "./compile.js";

const ERC20_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address account) view returns (uint256)"]);

const GET_ORDER_ABI = parseAbi(["function getOrder(uint128 orderId) view returns ((uint128 orderId, bool isBid, address owner, uint64 userData, uint256 price, uint256 fullQuantity, uint256 quantityRemaining, uint64 expireTimestampNs))"]);

const FUND_AMOUNT = 2_000_000n; // 2 tUSDC, raw 6-decimal units, tiny

async function main(): Promise<void> {
  const ctx = createChainContext();
  const cfg = loadConfig();
  console.log(`deployer/owner: ${ctx.account.address}`);

  const collateral = cfg.addresses.collateral ?? cfg.addresses.testUsdc;
  if (!collateral) throw new Error("no collateral address resolved from ec-core config");
  console.log(`collateral (tUSDC, live-resolved): ${collateral}`);

  console.log(`\nresolving a live Trading market...`);
  const roCtx = createReadOnlyContext();
  const live = await listLiveMarkets(roCtx);
  const picked = live.find((m) => m.ttlSec > 600);
  if (!picked) throw new Error("no live Trading market with enough runway");
  const { market, onchain } = await resolveMarket(roCtx, picked.symbol);
  const definition = await getMarketDefinition(roCtx, market);
  console.log(`market: ${picked.symbol}`);
  console.log(`pool: ${onchain.pool}`);
  console.log(`live tick=${definition.tickSize} lot=${definition.lotSize} minQty=${definition.minQuantity}`);

  console.log(`\ncompiling ContractOrderGate...`);
  const { abi, bytecode } = compileContract("ContractOrderGate.sol", "ContractOrderGate");
  console.log(`compiled OK (bytecode ${bytecode.length} chars)`);

  console.log(`\ndeploying...`);
  const deployHash = await ctx.walletClient.deployContract({ abi, bytecode, args: [onchain.pool, collateral], account: ctx.account, chain: ctx.walletClient.chain });
  console.log(`deploy tx: ${deployHash}`);
  const deployReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (deployReceipt.status !== "success" || !deployReceipt.contractAddress) throw new Error(`deployment failed: status=${deployReceipt.status}`);
  const gate = deployReceipt.contractAddress;
  console.log(`deployed at: ${gate}`);
  console.log(`gas used: ${deployReceipt.gasUsed}`);

  console.log(`\nfunding contract with ${FUND_AMOUNT} raw tUSDC...`);
  const fundHash = await ctx.walletClient.writeContract({ address: collateral, abi: ERC20_ABI, functionName: "transfer", args: [gate, FUND_AMOUNT], account: ctx.account, chain: ctx.walletClient.chain });
  await ctx.publicClient.waitForTransactionReceipt({ hash: fundHash });
  const gateBal = await ctx.publicClient.readContract({ address: collateral, abi: ERC20_ABI, functionName: "balanceOf", args: [gate] });
  console.log(`fund tx: ${fundHash}`);
  console.log(`contract collateral balance: ${gateBal}`);

  const { yes } = outcomeSymbols(market);
  const book = await roCtx.exchange.fetchOrderBook(yes, 3);
  const bestBid = book.bids[0]?.[0];
  if (bestBid === undefined) throw new Error("no bids on this market's book, pick a different market");
  const tick = definition.tickSize;
  const lot = definition.lotSize;
  const oneUnit = 10 ** definition.decimals;
  const rawBid = BigInt(Math.round(bestBid * oneUnit));
  const target = rawBid > 5n * tick ? rawBid - 5n * tick : tick;
  const priceAligned = target - (target % tick);
  const quantity = lot * 2n; // small: two lots

  console.log(`\nplacing BUY_YES post-only via the contract: price=${priceAligned} (raw) quantity=${quantity} (raw), a few ticks below best bid ${bestBid}`);
  const placeSim = await ctx.publicClient.simulateContract({ address: gate, abi, functionName: "placeOrder", args: [0, priceAligned, quantity], account: ctx.account });
  const orderId = placeSim.result as bigint;
  const placeHash = await ctx.walletClient.writeContract(placeSim.request);
  console.log(`place tx: ${placeHash}`);
  const placeReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: placeHash });
  if (placeReceipt.status !== "success") throw new Error(`place failed: status=${placeReceipt.status}`);
  console.log(`place status: success, gas used: ${placeReceipt.gasUsed}`);
  console.log(`order id: ${orderId}`);

  const resting = await ctx.publicClient.readContract({ address: onchain.pool, abi: GET_ORDER_ABI, functionName: "getOrder", args: [orderId] });
  console.log(`\nresting order read back from the pool:`);
  console.log(`  owner: ${resting.owner}`);
  console.log(`  price: ${resting.price} quantityRemaining: ${resting.quantityRemaining}`);
  const ownedByContract = resting.owner.toLowerCase() === gate.toLowerCase();
  console.log(`  owner is the contract: ${ownedByContract}`);
  if (!ownedByContract) throw new Error(`order owner ${resting.owner} does not match contract ${gate}`);

  console.log(`\ncancelling via the contract...`);
  const cancelSim = await ctx.publicClient.simulateContract({ address: gate, abi, functionName: "cancelOrder", args: [orderId], account: ctx.account });
  const cancelHash = await ctx.walletClient.writeContract(cancelSim.request);
  console.log(`cancel tx: ${cancelHash}`);
  const cancelReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: cancelHash });
  if (cancelReceipt.status !== "success") throw new Error(`cancel failed: status=${cancelReceipt.status}`);
  console.log(`cancel status: success, gas used: ${cancelReceipt.gasUsed}`);

  const afterCancel = await ctx.publicClient.readContract({ address: onchain.pool, abi: GET_ORDER_ABI, functionName: "getOrder", args: [orderId] });
  console.log(`\norder read back after cancel:`);
  console.log(`  owner: ${afterCancel.owner} quantityRemaining: ${afterCancel.quantityRemaining}`);
  const gone = afterCancel.quantityRemaining === 0n;
  console.log(`  quantityRemaining is zero (gone): ${gone}`);

  console.log(`\n=== VERDICT ===`);
  console.log(`a deployed contract, holding its own collateral, placed and cancelled a binary order.`);
  console.log(`deploy: ${deployHash}`);
  console.log(`place: ${placeHash}`);
  console.log(`cancel: ${cancelHash}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
