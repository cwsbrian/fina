/** Plaid sign convention: positive amount = money out (expense),
 *  negative = money in (income/refund). DTOs ship amount as a string,
 *  so a malformed value would silently become NaN — guard against that
 *  by defaulting to "expense" (the dominant case) when not finite. */
export function txDirection(amount: string): "expense" | "income" {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "expense";
  return n >= 0 ? "expense" : "income";
}
