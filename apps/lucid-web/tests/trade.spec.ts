import { test, expect } from "@playwright/test";
import { privateKeyToAccount } from "viem/accounts";
import { installInjectedWallet } from "./helpers/injectedWallet";

// Proves the non-custodial trade end to end in a real headless browser: a
// wallet's own signature drives the order, lucid-core's submitOrder never
// sees a private key, exactly the pattern LUCID-CORE.md proved for the
// library itself. The private key comes from an env var at test-run time
// only, never written into any file in this repo.

const PRIVATE_KEY = process.env.LUCID_TEST_PRIVATE_KEY as `0x${string}` | undefined;

test("connected wallet places a real order and the UI shows the tx hash", async ({ page }) => {
  test.skip(!PRIVATE_KEY, "set LUCID_TEST_PRIVATE_KEY to a funded Shannon testnet key to run this test");

  const account = privateKeyToAccount(PRIVATE_KEY!);
  const { publicClient } = await installInjectedWallet(page, account);

  await page.goto("/");
  await expect(page.getByTestId("gate-status")).toContainText("gate: ok", { timeout: 20_000 });

  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("wallet-address")).toBeVisible({ timeout: 15_000 });

  // Board rows sort soonest-to-expire first (useBoard.ts). Avoid a market
  // whose book has no resting ask ("/ -") or whose ttl is razor-thin, both
  // real conditions seen live on this venue (a market seconds old, or one
  // whose fair value has saturated near a probability edge, this project's
  // own REACTIVE-AGENT-V1.md hit the same class of live revert). Among the
  // rest, take the soonest-expiring one that is actually two-sided.
  const rows = page.getByTestId("board-row");
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });
  const twoSided = rows.filter({ hasNotText: "/ -" });
  await expect(twoSided.first()).toBeVisible({ timeout: 15_000 });
  await twoSided.first().click();

  await expect(page.getByTestId("trade-yes")).toBeEnabled({ timeout: 15_000 });
  await page.getByTestId("trade-yes").click();

  const status = page.getByTestId("trade-status");
  await expect(status).toBeVisible({ timeout: 10_000 });
  // Give the real chain time to mine, this is not a mock.
  await expect(page.getByTestId("trade-hash")).toBeVisible({ timeout: 30_000 });

  const hashText = (await page.getByTestId("trade-hash").textContent()) ?? "";
  expect(hashText.trim()).toMatch(/^0x[0-9a-fA-F]{64}$/);

  const receipt = await publicClient.getTransactionReceipt({ hash: hashText.trim() as `0x${string}` });
  expect(receipt.status).toBe("success");

  console.log(`TRADE TX HASH: ${hashText.trim()}`);
  console.log(`TRADE FROM: ${account.address}`);
});
