import { test, expect } from "@playwright/test";
import { resolveSelectedRow } from "../src/lib/selection";
import type { BoardRow } from "../src/lib/useBoard";

// Pure logic test, no browser, no chain: resolveSelectedRow must never fall
// back to an arbitrary other row. This is the exact invariant the app
// depends on to guarantee the open market detail view never silently
// becomes a different market than the one the user is actually looking at.

function row(symbol: string): BoardRow {
  // Only symbol is ever read by resolveSelectedRow; the rest is padding to
  // satisfy the type without pulling in any real market data.
  return { symbol, asset: "ETH", marketId: `0x${symbol}`, market: {} as never, onchain: {} as never, fv: {} as never };
}

test("resolveSelectedRow finds the exact selected symbol when it is on the board", () => {
  const rows = [row("A"), row("B"), row("C")];
  const found = resolveSelectedRow(rows, "B");
  expect(found?.symbol).toBe("B");
});

test("resolveSelectedRow returns null, never rows[0], when the selected symbol is not on the board", () => {
  const rows = [row("A"), row("B"), row("C")];
  const found = resolveSelectedRow(rows, "Z");
  expect(found).toBeNull();
  // The specific regression this guards: falling back to the first row
  // would silently substitute a different market. Confirm it does not,
  // explicitly, not just by checking null.
  expect(found).not.toBe(rows[0]);
});

test("resolveSelectedRow returns null when the board is empty but a market is selected", () => {
  const found = resolveSelectedRow([], "A");
  expect(found).toBeNull();
});

test("resolveSelectedRow returns null when nothing is selected, regardless of board contents", () => {
  const rows = [row("A"), row("B")];
  expect(resolveSelectedRow(rows, null)).toBeNull();
});

test("resolveSelectedRow stays pinned to the selected symbol across a board refresh that drops and later re-adds it", () => {
  const withMarket = [row("A"), row("B")];
  const withoutMarket = [row("B"), row("C")]; // "A" dropped, e.g. ttlSec <= 30 or a transient resolve failure
  const backAgain = [row("A"), row("B"), row("C")];

  expect(resolveSelectedRow(withMarket, "A")?.symbol).toBe("A");
  expect(resolveSelectedRow(withoutMarket, "A")).toBeNull();
  expect(resolveSelectedRow(backAgain, "A")?.symbol).toBe("A");
});
