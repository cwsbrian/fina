/** Format a decimal-string amount as currency. Backend stores tx amounts
 *  as Prisma Decimal serialized to a string (e.g. "12.34", "-87.43").
 *  Plaid convention: positive = money OUT (expense), negative = money IN
 *  (income). The UI flips the sign for income so it reads "$2,840" not
 *  "-$2,840" and tags it with a color instead. */

export type MoneyFormat = {
  display: string;        // "$24.50"
  isIncome: boolean;      // true when the raw amount is negative
};

export function formatMoney(amount: string, currency = "CAD"): MoneyFormat {
  const n = Number(amount);
  if (!Number.isFinite(n)) return { display: amount, isIncome: false };
  const abs = Math.abs(n);
  const isIncome = n < 0;
  const intl = new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  // Intl will already include the currency symbol; we strip the negative
  // sign because the color/+ prefix conveys direction instead.
  return { display: intl.format(abs), isIncome };
}

export function isExpenseAmount(amount: string): boolean {
  const n = Number(amount);
  return Number.isFinite(n) && n > 0;
}

/** Bucket an ISO date into a section title for the Activity list. */
export function dateBucket(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const toDay = (x: Date): number => {
    const y = new Date(x);
    y.setHours(0, 0, 0, 0);
    return y.getTime();
  };
  const today = toDay(now);
  const days = Math.round((today - toDay(d)) / 86400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) {
    return d.toLocaleDateString("en-CA", { weekday: "long" });
  }
  return d.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}
