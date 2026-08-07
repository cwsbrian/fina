import { createContext, ReactNode, useContext } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, space, type as type$ } from "../../design/tokens";
import { currencySymbol as formatCurrencySymbol } from "../../format/money";

/** Render a category's icon. The `icon` field stores an Ionicons glyph
 *  name (e.g. "cart-outline"); render it as a vector icon. Fall back to
 *  text for any non-Ionicons value (e.g. a legacy emoji), and render
 *  nothing when absent. */
export function CategoryIcon({
  icon,
  size = 13,
  color,
}: {
  icon?: string | null | undefined;
  size?: number | undefined;
  color?: string | null | undefined;
}) {
  if (!icon) return null;
  // Decorative — the adjacent category name carries the meaning, so hide
  // the icon from screen readers (otherwise they read the glyph name).
  if (icon in Ionicons.glyphMap) {
    return (
      <Ionicons
        name={icon as keyof typeof Ionicons.glyphMap}
        size={size}
        color={color ?? colors.body}
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
    );
  }
  return (
    <Text
      style={{ fontSize: size }}
      numberOfLines={1}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      {icon}
    </Text>
  );
}

type BlockPresentation = "card" | "sheet";

const BlockPresentationContext = createContext<BlockPresentation>("card");

export function BlockPresentationProvider({
  value,
  children,
}: {
  value: BlockPresentation;
  children: ReactNode;
}) {
  return (
    <BlockPresentationContext.Provider value={value}>{children}</BlockPresentationContext.Provider>
  );
}

/** Outer container shared by every assistant block other than plain text.
 *  Same surface treatment as the existing confirm card so visual hierarchy
 *  stays consistent across block types. */
export function BlockCard({ children }: { children: ReactNode }) {
  const presentation = useContext(BlockPresentationContext);
  if (presentation === "sheet") return <View style={styles.sheet}>{children}</View>;
  return <View style={styles.card}>{children}</View>;
}

/** Header row for cards — title + optional small subtitle (period_label,
 *  date range, etc). Pass `chevron` for cards whose whole surface is
 *  tappable — it renders a trailing ›  to signal "tap to open". */
export function BlockHeader({
  title,
  subtitle,
  chevron,
}: {
  title: string;
  subtitle?: string | undefined;
  chevron?: boolean | undefined;
}) {
  const titleCol = (
    <View style={chevron ? styles.headerTextCol : undefined}>
      <Text style={styles.title} numberOfLines={2}>
        {title}
      </Text>
      {subtitle ? (
        <Text style={styles.subtitle} numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
  if (!chevron) return <View style={styles.header}>{titleCol}</View>;
  return (
    <View style={styles.headerRow}>
      {titleCol}
      <Ionicons name="chevron-forward" size={18} color={colors.muted} />
    </View>
  );
}

/** Big-number area below the header. Optional label above the amount, optional
 *  delta pill below. */
export function HeadlineAmount({
  label,
  amount,
  delta,
  sub,
}: {
  label?: string;
  amount: string;
  delta?: { value: string; direction: "up" | "down" };
  sub?: string;
}) {
  return (
    <View style={styles.headline}>
      {label ? <Text style={styles.headlineLabel}>{label}</Text> : null}
      <Text style={styles.headlineAmount}>{amount}</Text>
      {sub ? <Text style={styles.rowSub}>{sub}</Text> : null}
      {delta ? <DeltaPill value={delta.value} direction={delta.direction} /> : null}
    </View>
  );
}

/** Small badge — "↑ 12%" or "↓ $4.50" — colored by direction. */
export function DeltaPill({ value, direction }: { value: string; direction: "up" | "down" }) {
  const color = direction === "up" ? colors.down : colors.up;
  // Spending UP is a "down" outcome (color red); for the recap card we treat
  // direction literally — caller decides semantics. Income/savings tools
  // should pass direction:"up" when MORE money is good, and renderer would
  // colorize accordingly. Keeping color tied to direction here means the
  // tool author owns the meaning.
  const arrow = direction === "up" ? "↑" : "↓";
  return (
    <Text style={[styles.deltaPill, { color }]}>
      {arrow} {value}
    </Text>
  );
}

/** Single detail row: label on the left, amount on the right, optional
 *  secondary text under the label, optional bar visualization. */
export function KVPRow({
  label,
  amount,
  sub,
  barPct,
  delta,
  projected,
  scheduled,
  severity,
  isLast,
}: {
  label: string;
  amount: string;
  sub?: string;
  barPct?: number;
  delta?: { value: string; direction: "up" | "down" };
  projected?: string;
  scheduled?: string;
  severity?: string;
  isLast?: boolean;
}) {
  return (
    <View style={[styles.row, !isLast && styles.rowBorder]}>
      <View style={styles.rowMain}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.rowLabel} numberOfLines={1}>
            {label}
          </Text>
          {sub ? (
            <Text style={styles.rowSub} numberOfLines={1}>
              {sub}
            </Text>
          ) : null}
          {projected ? (
            <Text style={styles.rowSub} numberOfLines={1}>
              {severity === "at_risk" ? "⚠️ " : ""}projected {projected}
              {scheduled ? ` · incl. ${scheduled} scheduled` : ""}
            </Text>
          ) : null}
        </View>
        <View style={styles.rowRight}>
          <Text style={styles.rowAmount}>{amount}</Text>
          {delta ? <DeltaPill value={delta.value} direction={delta.direction} /> : null}
        </View>
      </View>
      {typeof barPct === "number" ? <RowBar pct={barPct} /> : null}
    </View>
  );
}

/** Thin proportional bar under a row, used by recap cards to show relative
 *  magnitude across the row set. Bar fills `barPct` of the available width. */
export function RowBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <View style={styles.barTrack}>
      <View style={[styles.barFill, { width: `${clamped}%` }]} />
    </View>
  );
}

/** Footer line — small muted text. */
export function BlockFooter({ text }: { text: string }) {
  return <Text style={styles.footer}>{text}</Text>;
}

/** Empty-state message inside an otherwise structured card. */
export function BlockEmpty({ text }: { text: string }) {
  return <Text style={styles.empty}>{text}</Text>;
}

/** Hex → translucent rgba. Expands #rgb shorthand, handles #rrggbb, and
 *  falls back to returning the input verbatim for any non-hex value
 *  (named colors, rgba strings, etc.). */
export function withAlpha(hex: string, alpha: number): string {
  const m6 = /^#([0-9a-f]{6})$/i.exec(hex);
  const m3 = /^#([0-9a-f]{3})$/i.exec(hex);
  let r: number, g: number, b: number;
  if (m6) {
    r = parseInt(m6[1]!.slice(0, 2), 16);
    g = parseInt(m6[1]!.slice(2, 4), 16);
    b = parseInt(m6[1]!.slice(4, 6), 16);
  } else if (m3) {
    r = parseInt(m3[1]![0]! + m3[1]![0]!, 16);
    g = parseInt(m3[1]![1]! + m3[1]![1]!, 16);
    b = parseInt(m3[1]![2]! + m3[1]![2]!, 16);
  } else {
    return hex;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Currency code → display symbol. Always returns a string; unknown,
 *  missing, or null codes fall back to "$". */
export function currencySymbol(code: string | undefined | null): string {
  return code ? formatCurrencySymbol(code) : "$";
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 16,
    paddingVertical: space.sm,
    paddingHorizontal: space.base,
    marginVertical: 4,
    gap: space.xs,
  },
  sheet: {
    gap: space.xs,
  },
  header: {
    gap: 2,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  headerTextCol: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  title: {
    ...type$.titleSm,
    color: colors.ink,
  },
  subtitle: {
    ...type$.caption,
    color: colors.muted,
  },
  headline: {
    paddingVertical: space.xs,
    gap: 2,
  },
  headlineLabel: {
    ...type$.caption,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  headlineAmount: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: "600",
    color: colors.ink,
  },
  deltaPill: {
    ...type$.caption,
    fontWeight: "600",
    marginTop: 2,
  },
  row: {
    paddingVertical: 10,
  },
  rowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  rowMain: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
  },
  rowLabel: {
    ...type$.bodyMd,
    color: colors.ink,
    fontWeight: "500",
  },
  rowSub: {
    ...type$.caption,
    color: colors.muted,
    marginTop: 1,
  },
  rowRight: {
    alignItems: "flex-end",
    gap: 2,
  },
  rowAmount: {
    ...type$.bodyMd,
    color: colors.ink,
    fontVariant: ["tabular-nums"],
  },
  barTrack: {
    marginTop: 8,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.hairline,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    backgroundColor: colors.primary,
  },
  footer: {
    ...type$.caption,
    color: colors.muted,
    marginTop: space.xs,
  },
  empty: {
    ...type$.bodySm,
    color: colors.muted,
    paddingVertical: space.xs,
    fontStyle: "italic",
  },
});
