import { test, expect } from "@playwright/test";
import { createLatestWinsGate } from "../src/lib/latestWins";

// Pure logic test, no browser, no chain, no React: simulates the exact
// out-of-order scenario the poll hooks need to survive, an earlier tick's
// async work resolving after a later tick has already started.

test("only the most recently started attempt is current when both are outstanding", () => {
  const gate = createLatestWinsGate();

  const earlier = gate.start(); // e.g. a slow RPC round trip that started first
  const later = gate.start(); // a faster later tick that started after and will finish first

  expect(gate.isCurrent(later)).toBe(true);
  expect(gate.isCurrent(earlier)).toBe(false);
});

test("simulates the concrete race: earlier tick resolves after later tick already committed", () => {
  const gate = createLatestWinsGate();
  const committed: string[] = [];

  function commitIfCurrent(token: number, value: string) {
    if (gate.isCurrent(token)) committed.push(value);
  }

  // Tick A starts (slow), tick B starts and finishes first (fast), then A
  // finally resolves. Only B's result should ever land.
  const tokenA = gate.start();
  const tokenB = gate.start();

  commitIfCurrent(tokenB, "B's fresh result");
  commitIfCurrent(tokenA, "A's stale result, arriving late");

  expect(committed).toEqual(["B's fresh result"]);
});

test("a lone attempt with nothing started after it is always current", () => {
  const gate = createLatestWinsGate();
  const token = gate.start();
  expect(gate.isCurrent(token)).toBe(true);
});

test("three overlapping attempts: only the last one started ever wins, regardless of finish order", () => {
  const gate = createLatestWinsGate();
  const t1 = gate.start();
  const t2 = gate.start();
  const t3 = gate.start();

  // Resolve in a scrambled order: 2, then 1, then 3.
  expect(gate.isCurrent(t2)).toBe(false);
  expect(gate.isCurrent(t1)).toBe(false);
  expect(gate.isCurrent(t3)).toBe(true);
});

test("an error path checks the same gate: a stale error must not overwrite fresher state either", () => {
  const gate = createLatestWinsGate();
  let error: string | null = null;
  let state = "initial";

  const tokenA = gate.start(); // will fail, but late
  const tokenB = gate.start(); // succeeds first

  // B succeeds first.
  if (gate.isCurrent(tokenB)) {
    state = "B's fresh state";
    error = null;
  }

  // A's failure arrives after B already committed; it must not clobber
  // B's good state with a stale error.
  if (gate.isCurrent(tokenA)) {
    error = "A's stale error";
  }

  expect(state).toBe("B's fresh state");
  expect(error).toBeNull();
});
