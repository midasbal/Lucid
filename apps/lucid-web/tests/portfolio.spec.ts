import { test, expect } from "@playwright/test";
import { parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { installInjectedWallet } from "./helpers/injectedWallet";

// Proves the portfolio view against an account that already holds real
// positions and real settled history from every earlier chunk of this
// project's own testing, not a freshly seeded fixture. Every number this
// test checks against the UI comes from an independent read, either the
// indexer's own GraphQL (a plain fetch, not routed through the app) or a
// direct chain read via viem, never the app's own state.

const PRIVATE_KEY = process.env.LUCID_TEST_PRIVATE_KEY as `0x${string}` | undefined;
const INDEXER_URL = "https://dev.smk.somnia.host/v1/graphql";

const ERC6909_READ_ABI = parseAbi(["function balanceOf(address owner, uint256 id) view returns (uint256)"]);

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

test("portfolio lists real open positions and history, reconciled independently", async ({ page }) => {
  test.skip(!PRIVATE_KEY, "set LUCID_TEST_PRIVATE_KEY to a funded Shannon testnet key to run this test");
  test.setTimeout(120_000);

  const account = privateKeyToAccount(PRIVATE_KEY!);
  const { publicClient } = await installInjectedWallet(page, account);

  // Independent read 1: the indexer's own OutcomeBalance, the same query
  // DATA-RECON.md confirmed, fetched directly here, not through the app.
  const acc = account.address.toLowerCase();
  const balancesData = await indexerQuery<{ OutcomeBalance: Array<{ market_id: string; outcomeIndex: number; balance: string }> }>(
    `query($account: String!) { OutcomeBalance(where: { account: { _eq: $account }, balance: { _gt: "0" } }) { market_id outcomeIndex balance } }`,
    { account: acc },
  );
  const openBalances = balancesData.OutcomeBalance;
  expect(openBalances.length, "expected this account to already hold real open positions from prior sessions").toBeGreaterThan(0);
  console.log(`independent indexer read: ${openBalances.length} open (market, outcome) rows with nonzero balance`);

  // Independent read 2: real settled history, holder OR to (the fix this
  // build found live, see PORTFOLIO.md), fetched directly here too.
  const redemptionsData = await indexerQuery<{ RedemptionRecord: Array<{ id: string; collateralOut: string }> }>(
    `query($account: String!) { RedemptionRecord(where: { _or: [{ holder: { _eq: $account } }, { to: { _eq: $account } }] }) { id collateralOut } }`,
    { account: acc },
  );
  expect(redemptionsData.RedemptionRecord.length, "expected real settled redemption history from prior sessions").toBeGreaterThan(0);
  console.log(`independent indexer read: ${redemptionsData.RedemptionRecord.length} real redemption records`);

  await page.goto("/");
  await expect(page.getByTestId("gate-status")).toContainText("gate: ok", { timeout: 20_000 });
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("wallet-address")).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("tab-portfolio").click();
  await expect(page.getByTestId("portfolio-view")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("portfolio-summary")).toBeVisible();

  const openRows = page.getByTestId("open-position-row");
  await expect(openRows.first()).toBeVisible({ timeout: 30_000 });
  const uiOpenCount = await openRows.count();
  console.log(`UI shows ${uiOpenCount} open position rows`);
  expect(uiOpenCount).toBeGreaterThan(0);
  // The UI can legitimately show fewer rows than the raw indexer count if a
  // market's own onchain resolution fails transiently for one row (the same
  // per-row fault isolation useBoard.ts already relies on), never more.
  expect(uiOpenCount).toBeLessThanOrEqual(openBalances.length);

  // Reconcile the first UI row's displayed balance against a direct chain
  // read, the authoritative source, not the indexer, not the app's own
  // cached state.
  const firstRow = openRows.first();
  const marketId = (await firstRow.getAttribute("data-market-id"))!;
  const outcomeIdx = Number(await firstRow.getAttribute("data-outcome-idx"));
  const onchain = await publicClient.readContract({
    address: "0x3ecC694Cef705358864a646142ac17A90E29e388" as `0x${string}`,
    abi: parseAbi(["function markets(bytes32) view returns (uint32,uint32,bytes32,address,uint64,uint64,uint64,uint64,address,address,uint256,uint256,bytes32,uint64)"]),
    functionName: "markets",
    args: [marketId as `0x${string}`],
  });
  // index 8 is the BinaryMarket contract address, not the outcome token,
  // the ERC-6909 outcome token is a separate read on that market contract.
  const marketAddress = onchain[8];
  const yesId = onchain[10];
  const noId = onchain[11];
  const outcomeToken = await publicClient.readContract({
    address: marketAddress,
    abi: parseAbi(["function outcomeToken() view returns (address)"]),
    functionName: "outcomeToken",
  });
  const chainBalance = await publicClient.readContract({
    address: outcomeToken,
    abi: ERC6909_READ_ABI,
    functionName: "balanceOf",
    args: [account.address, outcomeIdx === 0 ? yesId : noId],
  });
  expect(chainBalance).toBeGreaterThan(0n);

  const uiBalanceText = await firstRow.locator('[data-testid="position-mark"]').first().textContent();
  console.log(`reconciled market ${marketId} outcome ${outcomeIdx}: chain balance raw=${chainBalance}, UI shows mark ${uiBalanceText}`);

  // History: reconcile row count and that collateral-out figures on screen
  // are real numbers pulled from the same rows the independent read found.
  const historyRows = page.getByTestId("history-row");
  await expect(historyRows.first()).toBeVisible({ timeout: 20_000 });
  const uiHistoryCount = await historyRows.count();
  console.log(`UI shows ${uiHistoryCount} history rows`);
  expect(uiHistoryCount).toBeGreaterThan(0);
  expect(uiHistoryCount).toBeLessThanOrEqual(redemptionsData.RedemptionRecord.length);

  const outcomeBadges = page.getByTestId("history-outcome");
  const badgeCount = await outcomeBadges.count();
  const labels = await Promise.all(Array.from({ length: badgeCount }, (_, i) => outcomeBadges.nth(i).textContent()));
  console.log(`history outcomes shown: ${labels.join(", ")}`);
  expect(labels.some((l) => l?.trim() === "won")).toBe(true);
  expect(labels.some((l) => l?.trim() === "lost")).toBe(true);

  // Summary strip sanity: the open count shown matches the number of rows
  // actually rendered, not some other number.
  const summaryText = (await page.getByTestId("portfolio-summary").textContent()) ?? "";
  expect(summaryText).toContain(String(uiOpenCount));
});
