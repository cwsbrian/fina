/** Allocate integer transaction cents by receipt-line weights using largest remainder.
 * Deterministic id ordering resolves equal fractions. Sum is always transactionCents. */
export function allocateProportionalCents(
  items: Array<{ id: string; cents: number }>,
  transactionCents: number,
): Map<string, number> {
  const positive = items.filter((item) => Number.isInteger(item.cents) && item.cents > 0);
  const subtotal = positive.reduce((sum, item) => sum + item.cents, 0);
  if (subtotal <= 0 || !Number.isInteger(transactionCents) || transactionCents <= 0) {
    throw new Error("invalid_proportional_allocation");
  }
  const calculated = positive.map((item) => {
    const exact = item.cents * transactionCents / subtotal;
    return { ...item, allocated: Math.floor(exact), fraction: exact - Math.floor(exact) };
  });
  let remainder = transactionCents - calculated.reduce((sum, item) => sum + item.allocated, 0);
  calculated.sort((a, b) => b.fraction - a.fraction || a.id.localeCompare(b.id));
  for (let i = 0; i < calculated.length && remainder > 0; i += 1, remainder -= 1) {
    calculated[i]!.allocated += 1;
  }
  return new Map(calculated.map((item) => [item.id, item.allocated]));
}
