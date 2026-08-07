/** Format a decimal-string amount as currency. Backend stores tx amounts
 *  as Prisma Decimal serialized to a string (e.g. "12.34", "-87.43").
 *  Plaid convention: positive = money OUT (expense), negative = money IN
 *  (income). The UI flips the sign for income so it reads "$2,840" not
 *  "-$2,840" and tags it with a color instead. */

export type MoneyFormat = {
  display: string; // "$24.50"
  isIncome: boolean; // true when the raw amount is negative
};

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  CAD: "$",
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  KRW: "₩",
};

export function currencySymbol(currency: string): string {
  const normalized = currency.toUpperCase();
  const knownSymbol = CURRENCY_SYMBOLS[normalized];
  if (knownSymbol) return knownSymbol;

  try {
    const parts = new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: normalized,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).formatToParts(0);
    return parts.find((part) => part.type === "currency")?.value ?? normalized;
  } catch {
    return normalized;
  }
}

export function formatMoney(amount: string, currency = "CAD"): MoneyFormat {
  const n = Number(amount);
  if (!Number.isFinite(n)) return { display: amount, isIncome: false };
  const abs = Math.abs(n);
  const isIncome = n < 0;
  const intl = new Intl.NumberFormat("en-CA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  // Compose the symbol ourselves so runtimes cannot expand USD to "US$"
  // or fall back to an ISO code such as "JPY".
  return { display: `${currencySymbol(currency)}${intl.format(abs)}`, isIncome };
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
