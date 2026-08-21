import { test, expect } from "@playwright/test";

// The load-bearing gate: does lucid-core, and everything it pulls in
// (ec-core, the markets SDK), actually run in a browser and make a real
// live call against testnet, not just bundle without error. A bundle that
// loads but throws at runtime is not a pass.
test("lucid-core runs client-side and reaches live testnet", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  await page.goto("/");
  await expect(page.getByTestId("gate-status")).toContainText("gate: ok", { timeout: 20_000 });

  const countText = await page.getByTestId("gate-count").textContent();
  const count = Number(countText?.replace(/\D/g, ""));
  expect(count).toBeGreaterThan(0);

  expect(consoleErrors, `console errors: ${consoleErrors.join("\n")}`).toHaveLength(0);
});
