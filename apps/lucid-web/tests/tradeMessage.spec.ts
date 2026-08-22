import { test, expect } from "@playwright/test";
import { isValidTradeSize, describeTradeResult } from "../src/lib/tradeMessage";

// Pure logic test, no browser, no chain: the validation guard and the
// message branching both need to be correct independent of any live order.

test("isValidTradeSize rejects NaN (a cleared input field)", () => {
  expect(isValidTradeSize(Number(""))).toBe(false);
});

test("isValidTradeSize rejects negative sizes", () => {
  expect(isValidTradeSize(-5)).toBe(false);
});

test("isValidTradeSize rejects zero", () => {
  expect(isValidTradeSize(0)).toBe(false);
});

test("isValidTradeSize rejects Infinity", () => {
  expect(isValidTradeSize(Infinity)).toBe(false);
});

test("isValidTradeSize accepts an ordinary positive size", () => {
  expect(isValidTradeSize(0.01)).toBe(true);
  expect(isValidTradeSize(5)).toBe(true);
});

test("describeTradeResult: no hash means nothing was ever sent, distinct from a real unfilled order", () => {
  const message = describeTradeResult("YES", 0.52, { filled: 0 });
  expect(message).toContain("not sent");
  expect(message.toLowerCase()).not.toContain("sent but did not cross");
});

test("describeTradeResult: a hash with zero fill means a real order was sent and did not cross", () => {
  const message = describeTradeResult("YES", 0.52, { filled: 0, hash: "0xabc" });
  expect(message).toContain("sent but did not cross");
  expect(message).not.toContain("not sent");
});

test("describeTradeResult: a hash with a positive fill reports the real fill amount", () => {
  const message = describeTradeResult("NO", 0.48, { filled: 2.5, hash: "0xabc" });
  expect(message).toContain("filled 2.500");
  expect(message).toContain("0.480");
});

test("describeTradeResult never reports a fill amount when nothing was actually sent", () => {
  // Defensive: even if filled were somehow nonzero with no hash (should not
  // happen given placeLimit's own shape), the no-hash branch must still win,
  // since "no hash" is the one signal that nothing reached the chain at all.
  const message = describeTradeResult("YES", 0.5, { filled: 3, hash: undefined });
  expect(message).toContain("not sent");
});
