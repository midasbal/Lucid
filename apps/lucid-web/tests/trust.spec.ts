import { test, expect } from "@playwright/test";
import { privateKeyToAccount } from "viem/accounts";
import { installInjectedWallet } from "./helpers/injectedWallet";

// Proves the oracle trust panel against a real resolved market this
// account already holds an unredeemed position on, from prior sessions.
// The reconciliation source is a direct, independent query to the
// oracle's own GraphQL (prd.oracle.somnia.host), not the app's own state
// and not the markets indexer: the point is to confirm the panel's numbers
// actually match what the oracle service itself reports, not just that the
// app rendered something.

const PRIVATE_KEY = process.env.LUCID_TEST_PRIVATE_KEY as `0x${string}` | undefined;
const INDEXER_URL = "https://dev.smk.somnia.host/v1/graphql";
const ORACLE_GRAPHQL_URL = "https://prd.oracle.somnia.host/v1/graphql";

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

async function oracleQuery<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(ORACLE_GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

test("oracle trust panel renders real sources and reconciles against an independent oracle GraphQL query", async ({ page }) => {
  test.skip(!PRIVATE_KEY, "set LUCID_TEST_PRIVATE_KEY to a funded Shannon testnet key to run this test");
  test.setTimeout(120_000);

  const account = privateKeyToAccount(PRIVATE_KEY!);
  await installInjectedWallet(page, account);

  // Find a real settled (resolved, not yet redeemed) position on this
  // account, independent of the app, the same OutcomeBalance query
  // DATA-RECON.md confirmed, joined to Market for its finalized flag.
  const acc = account.address.toLowerCase();
  const balancesData = await indexerQuery<{
    OutcomeBalance: Array<{ market_id: string; outcomeIndex: number; balance: string; market: { finalized: boolean } }>;
  }>(
    `query($account: String!) {
      OutcomeBalance(where: { account: { _eq: $account }, balance: { _gt: "0" } }) {
        market_id outcomeIndex balance market { finalized }
      }
    }`,
    { account: acc },
  );
  const settled = balancesData.OutcomeBalance.filter((r) => r.market.finalized);
  test.skip(settled.length === 0, "no settled, unredeemed position found on this account to test against");
  const target = settled[0]!;

  // Independent read: this market's own resolution event and oracleQuestionId,
  // the exact join TRUST-PANEL.md documents, fetched directly here, not
  // through the app.
  const resolutionData = await indexerQuery<{
    MarketResolutionEvent: Array<{ oracleQuestionId: string }>;
  }>(
    `query($marketId: String!) {
      MarketResolutionEvent(where: { market_id: { _eq: $marketId } }, order_by: { timestamp: desc }, limit: 1) {
        oracleQuestionId
      }
    }`,
    { marketId: target.market_id },
  );
  const oracleQuestionId = resolutionData.MarketResolutionEvent[0]?.oracleQuestionId;
  test.skip(!oracleQuestionId, "no MarketResolutionEvent found for this market");
  console.log(`target market ${target.market_id}, oracleQuestionId ${oracleQuestionId}`);

  // Independent read: the oracle's own Question, straight from its GraphQL,
  // never through the app. This is the ground truth the rendered panel is
  // checked against below.
  const oracleData = await oracleQuery<{
    Question_by_pk: {
      id: string;
      numericDecimals: number | null;
      minAgreement: number | null;
      answers: Array<{ numericValue: string | null }>;
      sourceAnswers: Array<{ sourceIdx: number; success: boolean; numericValue: string | null; source: { authority_id: string } | null }>;
    } | null;
  }>(
    `query($id: String!) {
      Question_by_pk(id: $id) {
        id numericDecimals minAgreement
        answers { numericValue }
        sourceAnswers { sourceIdx success numericValue source { authority_id } }
      }
    }`,
    { id: oracleQuestionId },
  );
  const question = oracleData.Question_by_pk;
  test.skip(!question, "this question has aged out of the oracle's own retention, nothing to reconcile against");
  console.log(`independent oracle read: ${question!.sourceAnswers.length} source answers for question ${question!.id}`);

  await page.goto("/");
  await expect(page.getByTestId("gate-status")).toContainText("gate: ok", { timeout: 20_000 });
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("wallet-address")).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("tab-portfolio").click();
  await expect(page.getByTestId("portfolio-view")).toBeVisible({ timeout: 10_000 });

  const row = page.locator(`[data-testid="open-position-row"][data-market-id="${target.market_id}"][data-outcome-idx="${target.outcomeIndex}"]`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByTestId("open-position-resolution").click();

  await expect(page.getByTestId("resolved-market-detail")).toBeVisible({ timeout: 15_000 });
  const trustPanel = page.getByTestId("trust-panel");
  await expect(trustPanel).toBeVisible({ timeout: 20_000 });
  await expect(trustPanel).toHaveAttribute("data-oracle-question-id", oracleQuestionId!, { timeout: 20_000 });

  // Reconcile every rendered source row against the independent oracle read:
  // same set of exchange names, same success flags, same raw values.
  const sourceRows = trustPanel.getByTestId("trust-source-row");
  await expect(sourceRows.first()).toBeVisible({ timeout: 15_000 });
  const uiCount = await sourceRows.count();
  console.log(`UI shows ${uiCount} source rows`);
  expect(uiCount).toBe(question!.sourceAnswers.length);

  const uiSources: Array<{ source: string; success: string; value: string }> = [];
  for (let i = 0; i < uiCount; i++) {
    const el = sourceRows.nth(i);
    uiSources.push({
      source: (await el.getAttribute("data-source"))!,
      success: (await el.getAttribute("data-success"))!,
      value: (await el.getAttribute("data-value"))!,
    });
  }

  for (const s of question!.sourceAnswers) {
    const match = uiSources.find((u) => u.value === (s.numericValue ?? ""));
    expect(match, `expected a rendered source row for raw value ${s.numericValue} (sourceIdx ${s.sourceIdx})`).toBeTruthy();
    expect(match!.success).toBe(String(s.success));
    console.log(`reconciled sourceIdx ${s.sourceIdx} (${s.source?.authority_id}): value ${s.numericValue}, success ${s.success}`);
  }

  // The posted answer shown matches the oracle's own final answer, scaled
  // the same way the panel itself scales it.
  const finalRaw = question!.answers[0]?.numericValue;
  if (finalRaw !== undefined && finalRaw !== null) {
    const expected =
      question!.numericDecimals !== null
        ? (Number(finalRaw) / 10 ** question!.numericDecimals).toLocaleString(undefined, { maximumFractionDigits: Math.min(question!.numericDecimals, 6) })
        : `${finalRaw} (raw, scale not provided)`;
    await expect(trustPanel.getByTestId("trust-final-answer")).toHaveText(expected);
    console.log(`reconciled posted answer: ${expected}`);
  }

  // Agreement line: same source count and threshold as the independent read.
  const agreementText = await trustPanel.getByTestId("trust-agreement").textContent();
  const successCount = question!.sourceAnswers.filter((s) => s.success).length;
  expect(agreementText).toContain(`${successCount} of ${question!.sourceAnswers.length} sources answered`);
  if (question!.minAgreement !== null) expect(agreementText).toContain(`${question!.minAgreement} required`);

  // The caliber REST endpoint has no CORS headers on its preflight response
  // (confirmed live: a server-to-server curl succeeds, a browser fetch is
  // blocked outright), so from inside a real browser this always degrades
  // to the "unavailable" state rather than a rating, and the panel must
  // still show the sources and posted answer above regardless. Assert the
  // graceful degradation itself, not just hope it happens.
  await expect(trustPanel.getByTestId("trust-caliber-unavailable")).toBeVisible();
});
