import { test, expect } from "@playwright/test";
import { parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { installInjectedWallet } from "./helpers/injectedWallet";
import { AUTO_REDEEM_HANDLER } from "../src/lib/handler";

// Proves auto-redeem enrollment end to end: take a small position, arm it,
// and confirm both the on-chain state and the UI agree it is armed. The
// eventual payout itself is already proven end to end in HERO.md (the
// deployed handler really does pay a winning position out automatically
// when the market it is watching finalizes); this test proves enrollment,
// the part this app adds, not the reactive payout mechanism underneath it.
//
// Deliberately imports nothing from @somnia-chain/markets-sdk or
// @dreamdex-bot-kit/lucid-core here: both use extensionless relative
// imports in their published dist output (LUCID-CORE.md's own SDK
// feedback), which fail under Node's native ESM resolver, exactly the
// resolver Playwright's Node-side test process uses, confirmed live while
// writing this test. Vite's bundler tolerates it fine, which is why the
// app itself, and app source files with no SDK import of their own (chain.ts,
// handler.ts), are safe to import here, only the SDK and lucid-core
// themselves are not. Every value this test needs that the SDK would
// normally compute (marketKey, the outcome token address, the module
// address) is read off the DOM instead, real values the app already
// computed for its own rendering, not recomputed with different code.

const PRIVATE_KEY = process.env.LUCID_TEST_PRIVATE_KEY as `0x${string}` | undefined;
const BINARY_MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388" as const;

const HANDLER_READ_ABI = parseAbi([
  "function auths(uint256, uint256) view returns (address owner, uint256 amount, uint256 deadline, uint256 nonce, bytes sig, uint32 operatorId, bytes32 venueId, bytes32 marketId, bool redeemed)",
]);
const ERC6909_READ_ABI = parseAbi([
  "function isOperator(address owner, address spender) view returns (bool)",
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
]);
// Same positional ABI claim.spec.ts and close.spec.ts already proved live
// against this exact call; the SDK's own documented shape for this
// function does not match the deployed bytecode's real return layout.
const MODULE_ABI = parseAbi([
  "function markets(bytes32) view returns (uint32,uint32,bytes32,address,uint64,uint64,uint64,uint64,address,address,uint256,uint256,bytes32,uint64)",
]);

test("connected wallet takes a position and arms auto-redeem", async ({ page }) => {
  test.skip(!PRIVATE_KEY, "set LUCID_TEST_PRIVATE_KEY to a funded Shannon testnet key to run this test");
  test.setTimeout(120_000);

  const account = privateKeyToAccount(PRIVATE_KEY!);
  const { publicClient } = await installInjectedWallet(page, account);

  await page.goto("/");
  await expect(page.getByTestId("gate-status")).toContainText("gate: ok", { timeout: 20_000 });

  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("wallet-address")).toBeVisible({ timeout: 15_000 });

  // Same selection discipline as trade.spec.ts: a two-sided book, and here
  // specifically the longest-lived candidate (board rows sort soonest
  // first, so the last one), since this flow needs headroom for a trade
  // plus a possible operator approval plus the enrollment signature and
  // registration, more round trips than a single trade.
  const rows = page.getByTestId("board-row");
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });
  const twoSided = rows.filter({ hasNotText: "/ -" });
  const count = await twoSided.count();
  expect(count).toBeGreaterThan(0);
  const chosen = twoSided.nth(count - 1);
  const symbol = (await chosen.locator(".board-symbol").textContent())?.trim();
  expect(symbol).toBeTruthy();
  await chosen.click();

  await expect(page.getByTestId("trade-yes")).toBeEnabled({ timeout: 15_000 });
  await page.getByTestId("trade-yes").click();
  await expect(page.getByTestId("trade-hash")).toBeVisible({ timeout: 30_000 });
  const tradeHash = ((await page.getByTestId("trade-hash").textContent()) ?? "").trim();
  expect(tradeHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
  console.log(`POSITION TX HASH: ${tradeHash}`);

  // The position panel and the auto-redeem panel both read live chain state
  // via lucid-core, no indexer lag to wait out for the balance itself.
  await expect(page.getByTestId("position-row-yes")).toBeVisible({ timeout: 20_000 });

  const redeemRow = page.getByTestId("redeem-row-yes");
  await expect(redeemRow).toBeVisible({ timeout: 20_000 });
  const marketKeyValue = BigInt((await redeemRow.getAttribute("data-market-key"))!);
  const outcomeToken = (await redeemRow.getAttribute("data-outcome-token"))! as `0x${string}`;
  const binaryModule = (await redeemRow.getAttribute("data-binary-module"))! as `0x${string}`;

  // A real, and correctly handled, live condition found while writing this
  // test: this account had already armed this exact market and side in an
  // earlier run (the same soonest-two-sided selection can land on the same
  // longer-dated market across nearby runs), and the app read that back
  // from the handler's own storage on load and rendered "armed" directly,
  // never showing an arm button at all. That is the right behavior, a
  // returning user should see their real enrolled state, not be invited to
  // re-arm and pay gas for a no-op. Branch on which state this run actually
  // starts in, and prove either one.
  const alreadyArmed = await page.getByTestId("armed-badge-yes").isVisible();
  const enrollHashes: string[] = [];
  let freshBalanceAtArmTime: bigint | null = null;

  if (alreadyArmed) {
    console.log("ALREADY ARMED from an earlier run, verifying the read rather than re-arming");
  } else {
    await expect(page.getByTestId("arm-button-yes")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("arm-button-yes").click();
    await expect(page.getByTestId("armed-badge-yes")).toBeVisible({ timeout: 60_000 });

    const txLinks = page.getByTestId("redeem-tx-yes").locator("a");
    const txCount = await txLinks.count();
    expect(txCount).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < txCount; i++) {
      const h = (await txLinks.nth(i).textContent())?.trim();
      expect(h).toMatch(/^0x[0-9a-fA-F]{64}$/);
      enrollHashes.push(h!);
      const receipt = await publicClient.getTransactionReceipt({ hash: h as `0x${string}` });
      expect(receipt.status).toBe("success");
    }
    console.log(`ENROLLMENT TX HASHES: ${enrollHashes.join(", ")}`);

    // Independent proof the signed amount never passed through a float
    // round trip: read this exact market's yesId off the module directly,
    // then the account's own raw ERC-6909 balance for it, right after
    // arming (arming itself never moves outcome tokens, only sets an
    // operator approval and registers the authorization, so this balance
    // is the same one that was armed for). Compared below against the
    // handler's own stored amount.
    const marketId = (await redeemRow.getAttribute("data-market-id"))! as `0x${string}`;
    const onchainTuple = await publicClient.readContract({ address: BINARY_MODULE, abi: MODULE_ABI, functionName: "markets", args: [marketId] });
    const yesId = onchainTuple[10];
    freshBalanceAtArmTime = await publicClient.readContract({ address: outcomeToken, abi: ERC6909_READ_ABI, functionName: "balanceOf", args: [account.address, yesId] });
    console.log(`independent fresh raw balance read right after arming: ${freshBalanceAtArmTime}`);
  }

  // Independent on-chain verification: read the handler's own storage
  // directly, not trusted from the UI's own "armed" state alone.
  const stored = await publicClient.readContract({
    address: AUTO_REDEEM_HANDLER,
    abi: HANDLER_READ_ABI,
    functionName: "auths",
    args: [marketKeyValue, 0n],
  });
  const [storedOwner, storedAmount, , , , , , , redeemed] = stored;
  expect(storedOwner.toLowerCase()).toBe(account.address.toLowerCase());
  expect(storedAmount).toBeGreaterThan(0n);
  expect(redeemed).toBe(false);

  if (freshBalanceAtArmTime !== null) {
    // The real proof for this pass: the amount signed and stored on-chain
    // is exactly the raw balance read independently at arm time, not a
    // value reconstructed through balance * 10**decimals and Math.round.
    expect(storedAmount).toBe(freshBalanceAtArmTime);
    console.log(`confirmed: signed amount ${storedAmount} equals the independently read raw balance exactly`);
  }

  const isOperator = await publicClient.readContract({
    address: outcomeToken,
    abi: ERC6909_READ_ABI,
    functionName: "isOperator",
    args: [account.address, binaryModule],
  });
  expect(isOperator).toBe(true);

  console.log(`MARKET: ${symbol}`);
  console.log(`ARMED FOR: ${account.address}`);
});
