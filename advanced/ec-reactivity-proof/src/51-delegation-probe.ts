// Decisive probe: does operator-delegated, non-custodial binary order
// placement work? owner = main EOA (holds collateral). operator = the
// Phase A relayer key, funded with gas only, holding no collateral.
//
// Every order placed here is post-only, resting a few ticks off best so it
// can never cross and fill, and every one is cancelled before this script
// exits.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAbi, toFunctionSelector, formatEther } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, loadConfig, resolveVenue, activeMarkets, marketOnchain, outcomeSymbols, MARKET_STATUS, shutdown } from "@dreamdex-bot-kit/ec-core";
import { toHuman } from "@somnia-chain/markets-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readEnvKey(file: string, varName: string): `0x${string}` {
  const content = readFileSync(path.resolve(__dirname, "..", file), "utf8");
  const match = content.match(new RegExp(`${varName}=(0x[0-9a-fA-F]+)`));
  if (!match) throw new Error(`${varName} not found in ${file}`);
  return match[1] as `0x${string}`;
}

const OWNER_KEY = readEnvKey(".env", "PRIVATE_KEY");
const OPERATOR_KEY = readEnvKey(".env.relayer", "RELAYER_PRIVATE_KEY");

const TARGET_MARKET_ID = ("0x" + "4712".padStart(64, "0")) as `0x${string}`;
const TICKS_BELOW = 3;
const NOTIONAL = 3;

const BOOK_PARAMS_ABI = parseAbi(["function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))"]);
const POOL_WRITE_ABI = parseAbi([
  "function placeBinaryOrderFor(address owner, uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool success, uint128 id)",
  "function cancelOrder(uint128 orderId)",
  "function isOperatorAuthorized(address owner, address operator, bytes4 selector) view returns (bool)",
]);
const REGISTRY_WRITE_ABI = parseAbi(["function setOperatorApprovalGlobal(address operator, bytes4[] selectors, bool approved)"]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const PLACE_BINARY_ORDER_FOR_SIG = "placeBinaryOrderFor(address,uint8,uint256,uint256,uint64,uint8,uint8,address,uint96,uint64)";
const PLACE_BINARY_ORDER_FOR_SELECTOR = toFunctionSelector(PLACE_BINARY_ORDER_FOR_SIG);

async function main(): Promise<void> {
  const ownerCtx = createChainContext(OWNER_KEY);
  const operatorCtx = createChainContext(OPERATOR_KEY);
  const cfg = loadConfig();

  console.log(`owner:    ${ownerCtx.account.address}`);
  console.log(`operator: ${operatorCtx.account.address}`);
  console.log(`\nplaceBinaryOrderFor signature: ${PLACE_BINARY_ORDER_FOR_SIG}`);
  console.log(`selector: ${PLACE_BINARY_ORDER_FOR_SELECTOR}`);

  const operatorBalBefore = await operatorCtx.publicClient.getBalance({ address: operatorCtx.account.address });
  console.log(`\noperator STT before: ${formatEther(operatorBalBefore)}`);

  const ecCtx = createExchange({ withSigner: false });
  await ecCtx.exchange.loadMarkets(true);
  await resolveVenue(ecCtx);
  const markets = await activeMarkets(ecCtx, { max: 1e6 });
  const market = markets.find((m) => m.info.marketType === "BINARY" && m.info.marketId.toLowerCase() === TARGET_MARKET_ID.toLowerCase());
  if (!market) throw new Error(`marketId ${TARGET_MARKET_ID} not active`);
  const onchain = await marketOnchain(ecCtx, market);
  if (!onchain || onchain.status !== MARKET_STATUS.Trading) throw new Error(`not Trading`);
  console.log(`\nmarket: ${market.symbol}, pool: ${onchain.pool}`);

  const params = await ownerCtx.publicClient.readContract({ address: onchain.pool, abi: BOOK_PARAMS_ABI, functionName: "getOrderBookParameters" });
  const one = 10n ** BigInt(cfg.decimals);
  const tickHuman = Number(params.tickSize) / Number(one);
  if (params.lotSize !== cfg.lot) {
    console.log(`lot mismatch: live=${params.lotSize} config=${cfg.lot} - set MM_LOT and re-run`);
    process.exit(1);
  }

  const { yes } = outcomeSymbols(market);
  const book = await ecCtx.exchange.fetchOrderBook(yes, 5);
  const bestBid = book.bids[0]?.[0];
  if (bestBid === undefined) throw new Error("no bids to rest below");
  const restPriceHuman = Math.max(bestBid - TICKS_BELOW * tickHuman, tickHuman);
  const restPriceRaw = BigInt(Math.round(restPriceHuman * Number(one)));
  const sizeHuman = NOTIONAL / restPriceHuman;
  const quantityRaw = (BigInt(Math.floor(sizeHuman * Number(one))) / params.lotSize) * params.lotSize;
  const expireNs = BigInt(Math.floor(Date.now() / 1000) + 300) * 1_000_000_000n;

  console.log(`\nYES best bid: ${bestBid}, resting ${TICKS_BELOW} ticks below at ${restPriceHuman.toFixed(6)} (raw ${restPriceRaw})`);
  console.log(`quantity raw: ${quantityRaw}`);

  // ===== Step 0: ensure owner has approved this pool for collateral =====
  // Isolates the test to operator authorization only. approve() is a normal
  // owner action, not part of the delegation question, and does not place
  // or fund any order by itself.
  console.log(`\n=== Step 0: owner collateral approval for this pool ===`);
  const ERC20_APPROVE_ABI = parseAbi(["function allowance(address owner, address spender) view returns (uint256)", "function approve(address spender, uint256 amount) returns (bool)"]);
  const currentAllowance = await ownerCtx.publicClient.readContract({ address: onchain.collateral, abi: ERC20_APPROVE_ABI, functionName: "allowance", args: [ownerCtx.account.address, onchain.pool] });
  console.log(`current allowance: ${currentAllowance}`);
  if (currentAllowance < quantityRaw) {
    const approveCollateralHash = await ownerCtx.walletClient.writeContract({
      address: onchain.collateral,
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [onchain.pool, 2n ** 256n - 1n],
      account: ownerCtx.account,
      chain: ownerCtx.walletClient.chain,
    });
    console.log(`approve tx: ${approveCollateralHash}`);
    const approveCollateralReceipt = await ownerCtx.publicClient.waitForTransactionReceipt({ hash: approveCollateralHash });
    console.log(`status: ${approveCollateralReceipt.status}`);
  } else {
    console.log("already sufficient, no approval tx needed");
  }

  // ===== Step 1: unapproved call =====
  console.log(`\n=== Step 1: unapproved placeBinaryOrderFor from operator ===`);
  let step1Reverted = false;
  let step1Reason = "";
  try {
    await operatorCtx.publicClient.simulateContract({
      address: onchain.pool,
      abi: POOL_WRITE_ABI,
      functionName: "placeBinaryOrderFor",
      args: [ownerCtx.account.address, 0, restPriceRaw, quantityRaw, expireNs, 3, 0, "0x0000000000000000000000000000000000000000", 0n, 0n],
      account: operatorCtx.account,
    });
    console.log("UNEXPECTED: simulation did not revert");
  } catch (e) {
    step1Reverted = true;
    step1Reason = (e as Error).message;
    console.log(`reverted as expected. reason: ${step1Reason}`);
  }

  // ===== Step 2: approve =====
  console.log(`\n=== Step 2: owner approves operator on OperatorPermissionsRegistry ===`);
  const registry = ownerCtx.net.operatorRegistry;
  console.log(`registry (live-resolved, spot config, testing whether it also gates binary): ${registry}`);

  const approveHash = await ownerCtx.walletClient.writeContract({
    address: registry,
    abi: REGISTRY_WRITE_ABI,
    functionName: "setOperatorApprovalGlobal",
    args: [operatorCtx.account.address, [PLACE_BINARY_ORDER_FOR_SELECTOR], true],
    account: ownerCtx.account,
    chain: ownerCtx.walletClient.chain,
  });
  console.log(`setOperatorApprovalGlobal tx: ${approveHash}`);
  const approveReceipt = await ownerCtx.publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log(`status: ${approveReceipt.status}`);

  console.log(`\nreading isOperatorAuthorized on the binary pool (not in the SDK's binaryPoolReadAbi, trying anyway)...`);
  let isAuthorized: boolean | null = null;
  try {
    isAuthorized = await ownerCtx.publicClient.readContract({
      address: onchain.pool,
      abi: POOL_WRITE_ABI,
      functionName: "isOperatorAuthorized",
      args: [ownerCtx.account.address, operatorCtx.account.address, PLACE_BINARY_ORDER_FOR_SELECTOR],
    });
    console.log(`isOperatorAuthorized(owner, operator, selector) = ${isAuthorized}`);
  } catch (e) {
    console.log(`read failed: ${(e as Error).message.split("\n")[0]}`);
  }

  // ===== Step 3: approved call =====
  console.log(`\n=== Step 3: placeBinaryOrderFor from operator, after approval ===`);
  const ownerCollateralBefore = await ownerCtx.publicClient.readContract({ address: onchain.collateral, abi: ERC20_ABI, functionName: "balanceOf", args: [ownerCtx.account.address] });
  const operatorCollateralBefore = await ownerCtx.publicClient.readContract({ address: onchain.collateral, abi: ERC20_ABI, functionName: "balanceOf", args: [operatorCtx.account.address] });
  console.log(`owner collateral before: ${toHuman(ownerCollateralBefore, cfg.decimals)}`);
  console.log(`operator collateral before: ${toHuman(operatorCollateralBefore, cfg.decimals)}`);

  let orderId: bigint | undefined;
  let step3Succeeded = false;
  let step3Reason = "";
  try {
    const placeHash = await operatorCtx.walletClient.writeContract({
      address: onchain.pool,
      abi: POOL_WRITE_ABI,
      functionName: "placeBinaryOrderFor",
      args: [ownerCtx.account.address, 0, restPriceRaw, quantityRaw, expireNs, 3, 0, "0x0000000000000000000000000000000000000000", 0n, 0n],
      account: operatorCtx.account,
      chain: operatorCtx.walletClient.chain,
    });
    console.log(`placeBinaryOrderFor tx: ${placeHash}`);
    const placeReceipt = await operatorCtx.publicClient.waitForTransactionReceipt({ hash: placeHash });
    console.log(`status: ${placeReceipt.status}, gas used: ${placeReceipt.gasUsed}`);
    step3Succeeded = placeReceipt.status === "success";

    for (const log of placeReceipt.logs) {
      if (log.address.toLowerCase() === onchain.pool.toLowerCase()) {
        console.log(`pool log topics: ${JSON.stringify(log.topics)}`);
      }
    }
  } catch (e) {
    step3Reason = (e as Error).message;
    console.log(`FAILED even after approval: ${step3Reason}`);
  }

  if (step3Succeeded) {
    await new Promise((r) => setTimeout(r, 2000));
    console.log(`\n=== Step 3 verification ===`);

    const ownerOpen = await ecCtx.exchange.fetchOpenOrders(yes);
    console.log(`fetchOpenOrders(${yes}) [unified, indexer-backed]: ${ownerOpen.length} order(s)`);
    for (const o of ownerOpen) console.log(`  ${JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    const ours = ownerOpen.find((o) => o.price === restPriceHuman);
    if (ours) orderId = BigInt(ours.id);

    const ownerCollateralAfter = await ownerCtx.publicClient.readContract({ address: onchain.collateral, abi: ERC20_ABI, functionName: "balanceOf", args: [ownerCtx.account.address] });
    const operatorCollateralAfter = await ownerCtx.publicClient.readContract({ address: onchain.collateral, abi: ERC20_ABI, functionName: "balanceOf", args: [operatorCtx.account.address] });
    console.log(`\nowner collateral after: ${toHuman(ownerCollateralAfter, cfg.decimals)} (change: ${toHuman(ownerCollateralAfter - ownerCollateralBefore, cfg.decimals)})`);
    console.log(`operator collateral after: ${toHuman(operatorCollateralAfter, cfg.decimals)} (change: ${toHuman(operatorCollateralAfter - operatorCollateralBefore, cfg.decimals)})`);
  }

  // ===== Step 4: cancel =====
  console.log(`\n=== Step 4: cancel ===`);
  console.log(`cancelBinaryOrderFor / cancelOrderFor: not present in tradeAbi.ts binaryPoolWriteAbi (confirmed by source read, only plain cancelOrder(uint128) exists)`);

  if (step3Succeeded && orderId !== undefined) {
    console.log(`cancelling order ${orderId} as the OWNER (not the operator) since no delegated cancel exists...`);
    const cancelHash = await ownerCtx.walletClient.writeContract({
      address: onchain.pool,
      abi: POOL_WRITE_ABI,
      functionName: "cancelOrder",
      args: [orderId],
      account: ownerCtx.account,
      chain: ownerCtx.walletClient.chain,
    });
    console.log(`cancel tx: ${cancelHash}`);
    const cancelReceipt = await ownerCtx.publicClient.waitForTransactionReceipt({ hash: cancelHash });
    console.log(`status: ${cancelReceipt.status}`);

    await new Promise((r) => setTimeout(r, 2000));
    const openAfter = await ecCtx.exchange.fetchOpenOrders(yes);
    console.log(`open orders after cancel: ${openAfter.length}`);
  } else {
    console.log("nothing to cancel (step 3 did not produce a resting order).");
  }

  const operatorBalAfter = await operatorCtx.publicClient.getBalance({ address: operatorCtx.account.address });
  console.log(`\noperator STT after: ${formatEther(operatorBalAfter)}, spent: ${formatEther(operatorBalBefore - operatorBalAfter)}`);

  console.log(`\n=== SUMMARY ===`);
  console.log(`step1Reverted: ${step1Reverted}, reason: ${step1Reason}`);
  console.log(`isOperatorAuthorized read: ${isAuthorized}`);
  console.log(`step3Succeeded: ${step3Succeeded}${step3Reason ? `, reason: ${step3Reason}` : ""}`);

  await shutdown(ecCtx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
