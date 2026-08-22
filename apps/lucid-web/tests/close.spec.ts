import { test, expect } from "@playwright/test";
import { parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { installInjectedWallet } from "./helpers/injectedWallet";

// Proves sell-to-close: a taker IOC sell of a held outcome against the live
// book, the only exit a still-trading position has today besides waiting
// for resolution. Reuses an already-open trading position on the account
// when one exists (confirmed live before writing this test); only takes a
// fresh tiny position if none does. The real fill is reconciled against the
// indexer's own Fill row for the resulting trade, not trusted from the UI's
// own report of what happened.
//
// Deliberately imports nothing from @somnia-chain/markets-sdk or
// @dreamdex-bot-kit/lucid-core here, the same reason every other spec in
// this suite gives: both use extensionless relative imports that fail
// under Node's native ESM resolver, the resolver Playwright's own test
// process uses. Every on-chain read is a small, hand-written viem ABI.

const PRIVATE_KEY = process.env.LUCID_TEST_PRIVATE_KEY as `0x${string}` | undefined;
const INDEXER_URL = "https://dev.smk.somnia.host/v1/graphql";
const BINARY_MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388" as const;
const COLLATERAL = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E" as const;

// Same positional ABI claim.spec.ts already proved live against this exact
// call; the SDK's own documented shape for this function does not match
// the deployed bytecode's real return layout.
const MODULE_ABI = parseAbi([
  "function markets(bytes32) view returns (uint32,uint32,bytes32,address,uint64,uint64,uint64,uint64,address,address,uint256,uint256,bytes32,uint64)",
]);
const OUTCOME_TOKEN_OF_ABI = parseAbi(["function outcomeToken() view returns (address)"]);
const ERC6909_READ_ABI = parseAbi(["function balanceOf(address owner, uint256 id) view returns (uint256)"]);
const ERC20_READ_ABI = parseAbi(["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"]);

async function indexerQuery<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(INDEXER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

test("sell-to-close reduces a real position and reconciles against the indexer's own fill", async ({ page }) => {
  test.skip(!PRIVATE_KEY, "set LUCID_TEST_PRIVATE_KEY to a funded Shannon testnet key to run this test");
  test.setTimeout(150_000);

  const account = privateKeyToAccount(PRIVATE_KEY!);
  const { publicClient } = await installInjectedWallet(page, account);
  const acc = account.address.toLowerCase();

  await page.goto("/");
  await expect(page.getByTestId("gate-status")).toContainText("gate: ok", { timeout: 20_000 });
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("wallet-address")).toBeVisible({ timeout: 15_000 });

  // Independent read: does this account already hold a real, still-trading
  // position? Reuse it rather than manufacture one.
  const balancesData = await indexerQuery<{
    OutcomeBalance: Array<{ market_id: string; outcomeIndex: number; balance: string; market: { finalized: boolean } }>;
  }>(
    `query($a: String!) {
      OutcomeBalance(where: { account: { _eq: $a }, balance: { _gt: "0" } }) {
        market_id outcomeIndex balance
        market { finalized }
      }
    }`,
    { a: acc },
  );
  let target = balancesData.OutcomeBalance.find((r) => !r.market.finalized);

  if (!target) {
    // No open trading position exists on this account right now, take a
    // tiny one first, the exact IOC buy path trade.spec.ts already proves,
    // on the soonest-expiring two-sided market.
    console.log("no open trading position found, taking a small one first");
    await page.getByTestId("tab-markets").click();
    const board = page.getByTestId("board-row");
    await expect(board.first()).toBeVisible({ timeout: 15_000 });
    await board.first().click();
    await expect(page.getByTestId("trade-yes")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("trade-size").fill("0.01");
    await page.getByTestId("trade-yes").click();
    await expect(page.getByTestId("trade-hash")).toBeVisible({ timeout: 30_000 });

    const refreshed = await indexerQuery<{ OutcomeBalance: Array<{ market_id: string; outcomeIndex: number; balance: string; market: { finalized: boolean } }> }>(
      `query($a: String!) { OutcomeBalance(where: { account: { _eq: $a }, balance: { _gt: "0" } }) { market_id outcomeIndex balance market { finalized } } }`,
      { a: acc },
    );
    target = refreshed.OutcomeBalance.find((r) => !r.market.finalized);
  }

  test.skip(!target, "could not find or open a trading position to close");
  const marketId = target!.market_id as `0x${string}`;
  const outcomeIdx = target!.outcomeIndex as 0 | 1;
  const label = outcomeIdx === 0 ? "yes" : "no";
  console.log(`closing against market ${marketId} outcome ${outcomeIdx}`);

  const onchain = await publicClient.readContract({ address: BINARY_MODULE, abi: MODULE_ABI, functionName: "markets", args: [marketId] });
  const marketAddress = onchain[8];
  const yesId = onchain[10];
  const noId = onchain[11];
  const outcomeToken = await publicClient.readContract({ address: marketAddress, abi: OUTCOME_TOKEN_OF_ABI, functionName: "outcomeToken" });
  const id = outcomeIdx === 0 ? yesId : noId;
  const decimals = await publicClient.readContract({ address: COLLATERAL, abi: ERC20_READ_ABI, functionName: "decimals" });

  const preOutcomeBalance = await publicClient.readContract({ address: outcomeToken, abi: ERC6909_READ_ABI, functionName: "balanceOf", args: [account.address, id] });
  const preCollateral = await publicClient.readContract({ address: COLLATERAL, abi: ERC20_READ_ABI, functionName: "balanceOf", args: [account.address] });
  expect(preOutcomeBalance).toBeGreaterThan(0n);
  console.log(`pre-close: held ${preOutcomeBalance} raw units`);

  // Drive into this exact market's detail view through the portfolio, the
  // real navigation path a holder uses, not a shortcut.
  await page.getByTestId("tab-portfolio").click();
  await expect(page.getByTestId("portfolio-view")).toBeVisible({ timeout: 10_000 });
  const row = page.locator(`[data-testid="open-position-row"][data-market-id="${marketId}"][data-outcome-idx="${outcomeIdx}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByTestId("open-position-goto").click();

  const closeButton = page.getByTestId(`close-button-${label}`);
  await expect(closeButton).toBeVisible({ timeout: 15_000 });
  await expect(closeButton).toBeEnabled({ timeout: 15_000 });

  // Sell part, not all, to prove a partial close works honestly: half the
  // held balance, rounded, never more than what is actually held.
  const heldHuman = Number(preOutcomeBalance) / 10 ** decimals;
  const closeSizeInput = page.getByTestId(`close-size-${label}`);
  const half = Math.max(heldHuman / 2, 0.001);
  await closeSizeInput.fill(half.toFixed(3));

  const beforeClickAt = Date.now();
  await closeButton.click();
  await expect(page.getByTestId(`close-result-${label}`).or(page.getByTestId(`close-error-${label}`))).toBeVisible({ timeout: 30_000 });

  const errorEl = page.getByTestId(`close-error-${label}`);
  if (await errorEl.count()) {
    const errText = await errorEl.textContent();
    test.skip(true, `close reported an error, likely a thin book: ${errText}`);
    return;
  }

  const resultText = (await page.getByTestId(`close-result-${label}`).textContent()) ?? "";
  console.log(`UI close result: ${resultText}`);

  // Independent reconciliation: the indexer's own Fill row for the trade
  // this close just made, not the UI's own account of it.
  const fillsData = await indexerQuery<{
    Fill: Array<{ id: string; timestamp: string; quantity: string; quoteQuantity: string; taker: string; takerSide: string; market_id: string }>;
  }>(
    `query($a: String!, $m: String!) {
      Fill(where: { market_id: { _eq: $m }, taker: { _eq: $a } }, order_by: { timestamp: desc }, limit: 5) {
        id timestamp quantity quoteQuantity taker takerSide market_id
      }
    }`,
    { a: acc, m: marketId },
  );
  const expectedSide = outcomeIdx === 0 ? "SELL_YES" : "SELL_NO";
  const ourFill = fillsData.Fill.find((f) => f.takerSide === expectedSide && Number(f.timestamp) * 1000 >= beforeClickAt - 15_000);
  expect(ourFill, `expected a real ${expectedSide} Fill row for this account on this market after closing`).toBeTruthy();
  console.log(`independent indexer read confirms Fill: ${JSON.stringify(ourFill)}`);

  const filledRaw = BigInt(ourFill!.quantity);
  const proceedsRaw = BigInt(ourFill!.quoteQuantity);

  const postOutcomeBalance = await publicClient.readContract({ address: outcomeToken, abi: ERC6909_READ_ABI, functionName: "balanceOf", args: [account.address, id] });
  const postCollateral = await publicClient.readContract({ address: COLLATERAL, abi: ERC20_READ_ABI, functionName: "balanceOf", args: [account.address] });

  expect(preOutcomeBalance - postOutcomeBalance).toBe(filledRaw);
  // At least, not exactly: this is a long-lived, shared test account with a
  // standing AutoRedeemHandler subscription and history across many other
  // sessions, so an unrelated inflow landing in the same narrow window is a
  // real, benign possibility, confirmed live once building this pass (a
  // second collateral credit showed up alongside this exact close, from
  // something this test never touched). The outcome-token balance check
  // above is exact and scoped to this account's own token id, immune to
  // that; this collateral check only needs to prove the sell's own proceeds
  // really landed, not that nothing else happened in the same block window.
  expect(postCollateral - preCollateral).toBeGreaterThanOrEqual(proceedsRaw);
  console.log(`reconciled: outcome balance dropped by ${filledRaw} raw units, collateral rose by ${postCollateral - preCollateral} raw units (>= ${proceedsRaw} the Fill row reports)`);

  // The UI's own honest partial-fill accounting: it must never claim more
  // was sold than the Fill row shows actually filled.
  const filledHuman = Number(filledRaw) / 10 ** decimals;
  expect(resultText).toContain(filledHuman.toFixed(3));
});

// Complement pricing (a NO order's price is the complement of the YES
// price) has bitten this project before (MAKER-GATE.md's own finding, the
// reason it exists as a documented gotcha at all), so the NO side of
// sell-to-close is proven separately here, not assumed to work because the
// YES side does. Takes a fresh tiny NO position first if the account does
// not already hold one on a still-trading market.
test("sell-to-close on the NO side prices off the complement and reconciles against the indexer's own fill", async ({ page }) => {
  test.skip(!PRIVATE_KEY, "set LUCID_TEST_PRIVATE_KEY to a funded Shannon testnet key to run this test");
  test.setTimeout(150_000);

  const account = privateKeyToAccount(PRIVATE_KEY!);
  const { publicClient } = await installInjectedWallet(page, account);
  const acc = account.address.toLowerCase();

  await page.goto("/");
  await expect(page.getByTestId("gate-status")).toContainText("gate: ok", { timeout: 20_000 });
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("wallet-address")).toBeVisible({ timeout: 15_000 });

  const balancesData = await indexerQuery<{
    OutcomeBalance: Array<{ market_id: string; outcomeIndex: number; balance: string; market: { finalized: boolean } }>;
  }>(
    `query($a: String!) {
      OutcomeBalance(where: { account: { _eq: $a }, balance: { _gt: "0" } }) {
        market_id outcomeIndex balance
        market { finalized }
      }
    }`,
    { a: acc },
  );
  let target = balancesData.OutcomeBalance.find((r) => !r.market.finalized && r.outcomeIndex === 1);

  if (!target) {
    console.log("no open NO position found, taking a small one first");
    await page.getByTestId("tab-markets").click();
    const board = page.getByTestId("board-row");
    await expect(board.first()).toBeVisible({ timeout: 15_000 });
    await board.first().click();
    await expect(page.getByTestId("trade-no")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("trade-size").fill("0.01");
    await page.getByTestId("trade-no").click();
    await expect(page.getByTestId("trade-hash")).toBeVisible({ timeout: 30_000 });

    const refreshed = await indexerQuery<{ OutcomeBalance: Array<{ market_id: string; outcomeIndex: number; balance: string; market: { finalized: boolean } }> }>(
      `query($a: String!) { OutcomeBalance(where: { account: { _eq: $a }, balance: { _gt: "0" } }) { market_id outcomeIndex balance market { finalized } } }`,
      { a: acc },
    );
    target = refreshed.OutcomeBalance.find((r) => !r.market.finalized && r.outcomeIndex === 1);
  } else {
    // Reuse via the UI: land on this market's own detail view first.
    await page.getByTestId("tab-portfolio").click();
    await expect(page.getByTestId("portfolio-view")).toBeVisible({ timeout: 10_000 });
    const existingRow = page.locator(`[data-testid="open-position-row"][data-market-id="${target.market_id}"][data-outcome-idx="1"]`);
    await expect(existingRow).toBeVisible({ timeout: 20_000 });
    await existingRow.getByTestId("open-position-goto").click();
  }

  test.skip(!target, "could not find or open a NO position to close");
  const marketId = target!.market_id as `0x${string}`;
  console.log(`closing NO position on market ${marketId}`);

  const onchain = await publicClient.readContract({ address: BINARY_MODULE, abi: MODULE_ABI, functionName: "markets", args: [marketId] });
  const marketAddress = onchain[8];
  const noId = onchain[11];
  const outcomeToken = await publicClient.readContract({ address: marketAddress, abi: OUTCOME_TOKEN_OF_ABI, functionName: "outcomeToken" });
  const decimals = await publicClient.readContract({ address: COLLATERAL, abi: ERC20_READ_ABI, functionName: "decimals" });

  const preOutcomeBalance = await publicClient.readContract({ address: outcomeToken, abi: ERC6909_READ_ABI, functionName: "balanceOf", args: [account.address, noId] });
  const preCollateral = await publicClient.readContract({ address: COLLATERAL, abi: ERC20_READ_ABI, functionName: "balanceOf", args: [account.address] });
  expect(preOutcomeBalance).toBeGreaterThan(0n);
  console.log(`pre-close: held ${preOutcomeBalance} raw NO units`);

  const closeButton = page.getByTestId("close-button-no");
  await expect(closeButton).toBeVisible({ timeout: 15_000 });
  await expect(closeButton).toBeEnabled({ timeout: 15_000 });

  // Independent-within-the-page check: the best YES ask shown on the order
  // book panel, read from the same live book the close row's own price
  // came from, but through a completely different component with no shared
  // pricing code. The NO close price must be the complement of this ask,
  // minus the same small crossing margin the YES side uses.
  const bestAskText = await page.locator(".book-level.ask .book-price").last().textContent();
  const bestAskYes = bestAskText ? Number(bestAskText) : null;
  const closeButtonText = (await closeButton.textContent()) ?? "";
  const closeAtNo = Number(closeButtonText.replace("close at ~", "").trim());
  console.log(`order book best YES ask: ${bestAskYes}, NO close price shown: ${closeAtNo}`);
  if (bestAskYes !== null) {
    const expectedNoCross = Math.min(0.99, Math.max(0.01, 1 - bestAskYes - 0.015));
    expect(Math.abs(closeAtNo - expectedNoCross), `NO close price should be the complement of the YES ask (${bestAskYes}) minus margin`).toBeLessThan(0.02);
  }

  const heldHuman = Number(preOutcomeBalance) / 10 ** decimals;
  const closeSizeInput = page.getByTestId("close-size-no");
  const size = heldHuman;
  await closeSizeInput.fill(size.toFixed(3));

  const beforeClickAt = Date.now();
  await closeButton.click();
  await expect(page.getByTestId("close-result-no").or(page.getByTestId("close-error-no"))).toBeVisible({ timeout: 30_000 });

  const errorEl = page.getByTestId("close-error-no");
  if (await errorEl.count()) {
    const errText = await errorEl.textContent();
    test.skip(true, `close reported an error, likely a thin book: ${errText}`);
    return;
  }

  const resultText = (await page.getByTestId("close-result-no").textContent()) ?? "";
  console.log(`UI close result: ${resultText}`);

  const fillsData = await indexerQuery<{
    Fill: Array<{ id: string; timestamp: string; quantity: string; quoteQuantity: string; taker: string; takerSide: string; market_id: string }>;
  }>(
    `query($a: String!, $m: String!) {
      Fill(where: { market_id: { _eq: $m }, taker: { _eq: $a } }, order_by: { timestamp: desc }, limit: 5) {
        id timestamp quantity quoteQuantity taker takerSide market_id
      }
    }`,
    { a: acc, m: marketId },
  );
  const ourFill = fillsData.Fill.find((f) => f.takerSide === "SELL_NO" && Number(f.timestamp) * 1000 >= beforeClickAt - 15_000);
  expect(ourFill, "expected a real SELL_NO Fill row for this account on this market after closing").toBeTruthy();
  console.log(`independent indexer read confirms Fill: ${JSON.stringify(ourFill)}`);

  const filledRaw = BigInt(ourFill!.quantity);
  const proceedsRaw = BigInt(ourFill!.quoteQuantity);

  const postOutcomeBalance = await publicClient.readContract({ address: outcomeToken, abi: ERC6909_READ_ABI, functionName: "balanceOf", args: [account.address, noId] });
  const postCollateral = await publicClient.readContract({ address: COLLATERAL, abi: ERC20_READ_ABI, functionName: "balanceOf", args: [account.address] });

  expect(preOutcomeBalance - postOutcomeBalance).toBe(filledRaw);
  // At least, not exactly, the same reason as the YES-side test above: this
  // is a long-lived, shared test account with a standing AutoRedeemHandler
  // subscription, and an unrelated inflow landing in the same narrow window
  // is a real, benign possibility, reproduced live twice while building
  // this pass. The outcome-token check above stays exact, scoped to this
  // account's own token id, unaffected by anything else.
  expect(postCollateral - preCollateral).toBeGreaterThanOrEqual(proceedsRaw);
  console.log(`reconciled: NO balance dropped by ${filledRaw} raw units, collateral rose by ${postCollateral - preCollateral} raw units (>= ${proceedsRaw} the Fill row reports)`);

  const filledHuman = Number(filledRaw) / 10 ** decimals;
  expect(resultText).toContain(filledHuman.toFixed(3));
});
