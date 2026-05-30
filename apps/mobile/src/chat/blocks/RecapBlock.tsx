import { View } from "react-native";
import type { PresentationBlock } from "@fina/shared";
import {
  BlockCard,
  BlockHeader,
  HeadlineAmount,
  KVPRow,
  BlockFooter,
  BlockEmpty,
} from "./_primitives";

type RecapBlockType = Extract<PresentationBlock, { type: "recap" }>;

type Props = { block: RecapBlockType };

/** Read-only spending/budget/cashflow recap card. Used by 5 tools:
 *  getSpendingSummary, getCategoryBreakdown, compareSpendingPeriods,
 *  getCashflowSummary, compareSpendingVsBudget.
 *
 *  Amounts arrive as plain decimal strings without currency symbols; we
 *  prepend the currency once on the headline and use a leaner number-only
 *  treatment for rows so the eye lines up cleanly down the column. */
export function RecapBlock({ block }: Props) {
  const currencySymbol = currencyToSymbol(block.headline?.currency);
  return (
    <BlockCard>
      {block.period_label ? (
        <BlockHeader title={block.title} subtitle={block.period_label} />
      ) : (
        <BlockHeader title={block.title} />
      )}

      {block.headline ? (
        <HeadlineAmount
          {...(block.headline.label !== undefined ? { label: block.headline.label } : {})}
          amount={formatHeadline(block.headline.amount, currencySymbol)}
          {...(block.headline.delta !== undefined ? { delta: block.headline.delta } : {})}
        />
      ) : null}

      {block.rows.length === 0 ? (
        <BlockEmpty text="No data for this period yet." />
      ) : (
        <View>
          {block.rows.map((r, i) => (
            <KVPRow
              key={`${r.label}-${i}`}
              label={r.label}
              amount={formatRowAmount(r.amount, currencySymbol)}
              {...(r.sub !== undefined ? { sub: r.sub } : {})}
              {...(typeof r.bar_pct === "number" ? { barPct: r.bar_pct } : {})}
              {...(r.delta !== undefined ? { delta: r.delta } : {})}
              {...(r.projected !== undefined ? { projected: r.projected } : {})}
              {...(r.severity !== undefined ? { severity: r.severity } : {})}
              isLast={i === block.rows.length - 1}
            />
          ))}
        </View>
      )}

      {block.footer ? <BlockFooter text={block.footer} /> : null}
    </BlockCard>
  );
}

/** Render the headline number with a currency prefix when one is supplied;
 *  otherwise leave the raw string alone so a tool can emit "75%" or "+12"
 *  for non-money headlines without the renderer guessing. */
function formatHeadline(amount: string, currencySymbol: string | null): string {
  if (!currencySymbol) return amount;
  return `${currencySymbol}${formatThousands(amount)}`;
}

/** Row amounts get the same treatment as the headline. We keep this thin
 *  so the column lines up via the tabular-nums font feature in the row
 *  styles, even when currency symbol widths differ. */
function formatRowAmount(amount: string, currencySymbol: string | null): string {
  if (!currencySymbol) return amount;
  return `${currencySymbol}${formatThousands(amount)}`;
}

/** Insert thousands separators into a decimal-string amount without losing
 *  precision (Intl.NumberFormat would force locale conventions and we want
 *  to preserve what the server sent). */
function formatThousands(amount: string): string {
  // Split sign + integer + decimal. The recap spec doesn't sign amounts
  // for spending (delta carries direction), but we handle it defensively.
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(amount);
  if (!m) return amount;
  const sign = m[1] ?? "";
  const intPart = (m[2] ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const dec = m[3] ?? "";
  return `${sign}${intPart}${dec}`;
}

/** Map ISO 4217 codes to the prefix the UI displays. Limited to the
 *  currencies we actively support; unknown codes fall through with no
 *  symbol so the renderer doesn't lie. */
function currencyToSymbol(code: string | undefined): string | null {
  if (!code) return null;
  switch (code.toUpperCase()) {
    case "CAD": return "$";
    case "USD": return "US$";
    case "EUR": return "€";
    case "GBP": return "£";
    case "JPY": return "¥";
    case "KRW": return "₩";
    default:    return null;
  }
}
