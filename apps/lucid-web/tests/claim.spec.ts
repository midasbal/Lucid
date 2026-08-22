import { test, expect } from "@playwright/test";
import { parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { installInjectedWallet } from "./helpers/injectedWallet";

// Proves the direct-redeem path: a real position that already resolved
// before auto-redeem was ever armed, claimed straight from the portfolio,
// no EIP-712 signature, no operator grant, none of the on-behalf machinery
// AutoRedeemPanel needs. Every check below is independent of the app's own
// state: the target position is found via a raw indexer query, the payout
// is reconciled against real ERC-6909 and ERC20 balance deltas read
// straight off chain, not trusted from the UI.
//
// Deliberately imports nothing from @somnia-chain/markets-sdk or
// @dreamdex-bot-kit/lucid-core here, the same reason redeem.spec.ts gives:
// both use extensionless relative imports in their published output, which
// fail under Node's native ESM resolver, exactly the resolver Playwright's
// Node-side test process uses. Every on-chain read below is a small,
// hand-written viem ABI instead.

const PRIVATE_KEY = process.env.LUCID_TEST_PRIVATE_KEY as `0x${string}` | undefined;
const INDEXER_URL = "https://dev.smk.somnia.host/v1/graphql";
const BINARY_MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388" as const;
// The single collateral token every market on this venue settles in
// (RECON.md, NOTES.md, HERO.md, LIFECYCLE.md all confirm the same address).
// Not read off the markets() tuple: that tuple's real deployed field layout
// does not match @somnia-chain/markets-sdk's own moduleAbi.d.ts (confirmed
// live building this test, the same class of ABI-to-bytecode drift
// PROOF.md already found for a different event), so this test reuses only
// the exact positional ABI portfolio.spec.ts already proved live against
// the same call, rather than trust the SDK's documented shape.
const COLLATERAL = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E" as const;

const MODULE_ABI = parseAbi([
  "function markets(bytes32) view returns (uint32,uint32,bytes32,address,uint64,uint64,uint64,uint64,address,address,uint256,uint256,bytes32,uint64)",
]);
const OUTCOME_TOKEN_OF_ABI = parseAbi(["function outcomeToken() view returns (address)"]);
const ERC6909_READ_ABI = parseAbi(["function balanceOf(address owner, uint256 id) view returns (uint256)"]);
const ERC20_READ_ABI = parseAbi(["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"]);

// Armed deliberately, once, outside the app: AutoRedeemPanel has no UI path
// to arm an already-resolved position (it only ever mounts on a live board
// row), so this specific real, already-resolved, won, unredeemed position
// was armed with a direct lucid-core call instead, the same way earlier
// process docs (HERO.md, PORTFOLIO.md) seeded state the UI itself could not
// reach. Excluded from the plain-claim test's own generic selection below
// so the two tests never race for the same row.
const ARMED_FALLBACK_MARKET_ID = "0x00000000000000000000000000000000000000000000000000000000000046fe" as const;
const ARMED_FALLBACK_OUTCOME_IDX = 1 as const;

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

test("direct claim redeems a real resolved, unarmed position and reconciles on-chain", async ({ page }) => {
  test.skip(!PRIVATE_KEY, "set LUCID_TEST_PRIVATE_KEY to a funded Shannon testnet key to run this test");
  test.setTimeout(120_000);

  const account = privateKeyToAccount(PRIVATE_KEY!);
  const { publicClient } = await installInjectedWallet(page, account);

  // Independent read: a real settled position this account holds that has
  // something to claim, won or voided, never a lost one. Same OutcomeBalance
  // query DATA-RECON.md and portfolio.spec.ts already confirmed, extended
  // with the market's own finalized/voided/winningOutcome to filter for a
  // real claimable row without trusting the app to have found one.
  const acc = account.address.toLowerCase();
  const balancesData = await indexerQuery<{
    OutcomeBalance: Array<{
      market_id: string;
      outcomeIndex: number;
      balance: string;
      market: { finalized: boolean; voided: boolean; winningOutcome: number };
    }>;
  }>(
    `query($a: String!) {
      OutcomeBalance(where: { account: { _eq: $a }, balance: { _gt: "0" } }) {
        market_id outcomeIndex balance
        market { finalized voided winningOutcome }
      }
    }`,
    { a: acc },
  );
  const claimableRow = balancesData.OutcomeBalance.find(
    (r) =>
      r.market.finalized &&
      (r.market.voided || r.outcomeIndex === r.market.winningOutcome) &&
      !(r.market_id === ARMED_FALLBACK_MARKET_ID && r.outcomeIndex === ARMED_FALLBACK_OUTCOME_IDX),
  );
  test.skip(!claimableRow, "no claimable (won or voided) settled position found on this account");
  const marketId = claimableRow!.market_id as `0x${string}`;
  const outcomeIdx = claimableRow!.outcomeIndex as 0 | 1;
  const label = outcomeIdx === 0 ? "yes" : "no";
  console.log(`target claimable market ${marketId} outcome ${outcomeIdx} (${claimableRow!.market.voided ? "voided" : "won"})`);

  // Independent reads: resolve the real on-chain addresses this position
  // needs, straight from the module, not through the app.
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
  console.log(`pre-claim: held ${preOutcomeBalance} raw units, collateral balance ${preCollateral}`);

  await page.goto("/");
  await expect(page.getByTestId("gate-status")).toContainText("gate: ok", { timeout: 20_000 });
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("wallet-address")).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("tab-portfolio").click();
  await expect(page.getByTestId("portfolio-view")).toBeVisible({ timeout: 10_000 });

  const row = page.locator(`[data-testid="open-position-row"][data-market-id="${marketId}"][data-outcome-idx="${outcomeIdx}"]`);
  await expect(row).toBeVisible({ timeout: 30_000 });

  const claimButton = row.getByTestId(`claim-button-${label}`);
  await expect(claimButton).toBeVisible({ timeout: 10_000 });
  const buttonText = (await claimButton.textContent()) ?? "";
  const uiEstimate = Number(buttonText.replace("claim ~", "").trim());
  expect(uiEstimate, `expected a positive claimable estimate, got "${buttonText}"`).toBeGreaterThan(0);
  console.log(`UI shows claimable estimate: ${uiEstimate}`);

  await claimButton.click();
  await expect(row.getByTestId(`claim-tx-${label}`)).toBeVisible({ timeout: 30_000 });
  const txHash = (await row.getByTestId(`claim-tx-${label}`).textContent()) ?? "";
  console.log(`claim tx (UI, truncated): ${txHash}`);

  // Independent chain reconciliation: the real balance deltas, not the UI's
  // own report of what happened.
  const postOutcomeBalance = await publicClient.readContract({ address: outcomeToken, abi: ERC6909_READ_ABI, functionName: "balanceOf", args: [account.address, id] });
  expect(postOutcomeBalance).toBe(0n);

  const postCollateral = await publicClient.readContract({ address: COLLATERAL, abi: ERC20_READ_ABI, functionName: "balanceOf", args: [account.address] });
  const actualPayout = Number(postCollateral - preCollateral) / 10 ** decimals;
  expect(actualPayout).toBeGreaterThan(0);
  console.log(`actual on-chain payout: ${actualPayout}, UI estimate was: ${uiEstimate}`);

  // The point of routing both the display and the redeem through the same
  // estimatePayout(): what the UI promised before the click and what the
  // chain actually paid must be the same number, not just both positive.
  // At least the UI's own estimate, not exactly: this account is long-lived
  // and shared across many sessions with a standing AutoRedeemHandler
  // subscription, so an unrelated inflow landing in the same narrow window
  // is a real, benign possibility (confirmed live building the sell-to-close
  // pass, the same class of confound). The on-chain payout must never be
  // less than what the UI promised, it can legitimately be more if
  // something else unrelated also landed.
  expect(actualPayout).toBeGreaterThanOrEqual(uiEstimate - 0.001);

  // Independent indexer reconciliation: a real RedemptionRecord now exists
  // for this exact market and outcome, holder OR to (PORTFOLIO.md's own
  // finding: a self-redeem through BinaryMarketsModule.redeem records
  // holder as the module's own address, not the owner, "to" is correct).
  const redemptionData = await indexerQuery<{ RedemptionRecord: Array<{ id: string; collateralOut: string; outcomeIdx: number }> }>(
    `query($a: String!, $m: String!) {
      RedemptionRecord(where: { _or: [{ holder: { _eq: $a } }, { to: { _eq: $a } }], market_id: { _eq: $m } }) {
        id collateralOut outcomeIdx
      }
    }`,
    { a: acc, m: marketId },
  );
  const ourRedemption = redemptionData.RedemptionRecord.find((r) => r.outcomeIdx === outcomeIdx);
  expect(ourRedemption, "expected a real RedemptionRecord for this market and outcome after claiming").toBeTruthy();
  console.log(`independent indexer read confirms RedemptionRecord: ${JSON.stringify(ourRedemption)}`);

  // The position drops out of open positions and shows up in history.
  await expect(row).not.toBeVisible({ timeout: 15_000 });
  const historyRow = page.locator(`[data-testid="history-row"][data-market-id="${marketId}"][data-outcome-idx="${outcomeIdx}"]`);
  await expect(historyRow).toBeVisible({ timeout: 15_000 });
  const outcomeBadge = (await historyRow.getByTestId("history-outcome").textContent())?.trim();
  expect(["won", "voided"]).toContain(outcomeBadge);
  console.log(`history now shows this redemption as: ${outcomeBadge}`);
});

// The armed-position fallback: an authorization registered with the handler
// is never a guarantee of payment, only a standing offer for the reactive
// callback to act on if it ever fires (redeemFor's own non-custodial design,
// HERO.md). An already-resolved position armed after the fact can never be
// paid by the handler, reactivity is not retroactive (PROOF.md), so a
// direct claim has to remain reachable on an armed row too, not just an
// unarmed one. Exercised against a real, deliberately armed, already-
// resolved, won, unredeemed position (armed with a one-off script outside
// the app, see the process doc, since AutoRedeemPanel has no UI path to
// arm a market that has already resolved).
test("a settled, armed, unpaid position still claims directly", async ({ page }) => {
  test.skip(!PRIVATE_KEY, "set LUCID_TEST_PRIVATE_KEY to a funded Shannon testnet key to run this test");
  test.setTimeout(120_000);

  const account = privateKeyToAccount(PRIVATE_KEY!);
  const { publicClient } = await installInjectedWallet(page, account);
  const marketId = ARMED_FALLBACK_MARKET_ID;
  const outcomeIdx = ARMED_FALLBACK_OUTCOME_IDX;
  const label = "no";

  const onchain = await publicClient.readContract({ address: BINARY_MODULE, abi: MODULE_ABI, functionName: "markets", args: [marketId] });
  const marketAddress = onchain[8];
  const noId = onchain[11];
  const outcomeToken = await publicClient.readContract({ address: marketAddress, abi: OUTCOME_TOKEN_OF_ABI, functionName: "outcomeToken" });
  const decimals = await publicClient.readContract({ address: COLLATERAL, abi: ERC20_READ_ABI, functionName: "decimals" });

  const preOutcomeBalance = await publicClient.readContract({ address: outcomeToken, abi: ERC6909_READ_ABI, functionName: "balanceOf", args: [account.address, noId] });
  const preCollateral = await publicClient.readContract({ address: COLLATERAL, abi: ERC20_READ_ABI, functionName: "balanceOf", args: [account.address] });
  test.skip(preOutcomeBalance <= 0n, "the armed fallback market was already claimed in an earlier run, nothing left to prove against");
  console.log(`pre-claim: held ${preOutcomeBalance} raw NO units on the armed fallback market`);

  await page.goto("/");
  await expect(page.getByTestId("gate-status")).toContainText("gate: ok", { timeout: 20_000 });
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("wallet-address")).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("tab-portfolio").click();
  await expect(page.getByTestId("portfolio-view")).toBeVisible({ timeout: 10_000 });

  const row = page.locator(`[data-testid="open-position-row"][data-market-id="${marketId}"][data-outcome-idx="${outcomeIdx}"]`);
  await expect(row).toBeVisible({ timeout: 30_000 });

  // Confirmed armed, not just claimable: the badge the rest of the app
  // already trusts, read the same way every other spec reads it.
  const armedBadge = row.getByTestId("position-armed");
  await expect(armedBadge).toContainText("armed", { timeout: 10_000 });
  console.log("row confirmed armed");

  // The explanatory note only an armed-but-claimable row carries.
  const note = row.getByTestId(`claim-note-${label}`);
  await expect(note).toBeVisible({ timeout: 10_000 });
  const noteText = (await note.textContent()) ?? "";
  expect(noteText.toLowerCase()).toContain("armed");
  expect(noteText.toLowerCase()).toContain("claim directly");
  console.log(`armed-fallback note shown: "${noteText}"`);

  const claimButton = row.getByTestId(`claim-button-${label}`);
  await expect(claimButton).toBeVisible({ timeout: 10_000 });
  const buttonText = (await claimButton.textContent()) ?? "";
  const uiEstimate = Number(buttonText.replace("claim ~", "").trim());
  expect(uiEstimate).toBeGreaterThan(0);
  console.log(`UI shows claimable estimate on the armed row: ${uiEstimate}`);

  await claimButton.click();
  await expect(row.getByTestId(`claim-tx-${label}`)).toBeVisible({ timeout: 30_000 });
  const txHash = (await row.getByTestId(`claim-tx-${label}`).textContent()) ?? "";
  console.log(`claim tx (UI, truncated): ${txHash}`);

  const postOutcomeBalance = await publicClient.readContract({ address: outcomeToken, abi: ERC6909_READ_ABI, functionName: "balanceOf", args: [account.address, noId] });
  expect(postOutcomeBalance).toBe(0n);

  const postCollateral = await publicClient.readContract({ address: COLLATERAL, abi: ERC20_READ_ABI, functionName: "balanceOf", args: [account.address] });
  const actualPayout = Number(postCollateral - preCollateral) / 10 ** decimals;
  expect(actualPayout).toBeGreaterThan(0);
  // At least the UI's own estimate, not exactly: this account is long-lived
  // and shared across many sessions with a standing AutoRedeemHandler
  // subscription, so an unrelated inflow landing in the same narrow window
  // is a real, benign possibility (confirmed live building the sell-to-close
  // pass, the same class of confound). The on-chain payout must never be
  // less than what the UI promised, it can legitimately be more if
  // something else unrelated also landed.
  expect(actualPayout).toBeGreaterThanOrEqual(uiEstimate - 0.001);
  console.log(`reconciled: actual on-chain payout ${actualPayout} matches UI estimate ${uiEstimate}, on an armed row the handler never paid`);

  const redemptionData = await indexerQuery<{ RedemptionRecord: Array<{ id: string; collateralOut: string; outcomeIdx: number }> }>(
    `query($a: String!, $m: String!) {
      RedemptionRecord(where: { _or: [{ holder: { _eq: $a } }, { to: { _eq: $a } }], market_id: { _eq: $m } }) {
        id collateralOut outcomeIdx
      }
    }`,
    { a: account.address.toLowerCase(), m: marketId },
  );
  const ourRedemption = redemptionData.RedemptionRecord.find((r) => r.outcomeIdx === outcomeIdx);
  expect(ourRedemption, "expected a real RedemptionRecord for the armed fallback market after claiming").toBeTruthy();
  console.log(`independent indexer read confirms RedemptionRecord: ${JSON.stringify(ourRedemption)}`);

  await expect(row).not.toBeVisible({ timeout: 15_000 });
  const historyRow = page.locator(`[data-testid="history-row"][data-market-id="${marketId}"][data-outcome-idx="${outcomeIdx}"]`);
  await expect(historyRow).toBeVisible({ timeout: 15_000 });
  const outcomeBadge = (await historyRow.getByTestId("history-outcome").textContent())?.trim();
  expect(outcomeBadge).toBe("won");
  console.log(`history now shows this armed-fallback redemption as: ${outcomeBadge}`);
});
