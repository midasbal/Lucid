import type { BoardRow } from "./useBoard";

/**
 * The board row for the currently selected symbol, or null. Never falls
 * back to an arbitrary other row (board.rows[0]): if the selected market
 * has dropped off the live board this cycle (expired, near-expiry filtered
 * out, or a single-market resolve failed transiently, useBoard.ts drops a
 * market rather than take the whole board down), the caller must show an
 * explicit non-live state for that same market and gate trading, never
 * silently substitute a different one. A user reading market A's price
 * must never end up trading against market B with no signal that anything
 * changed.
 */
export function resolveSelectedRow(rows: BoardRow[], selected: string | null): BoardRow | null {
  if (!selected) return null;
  return rows.find((r) => r.symbol === selected) ?? null;
}
