import { ReactNode } from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors, space, type as type$ } from "../../design/tokens";

/** Outer container shared by every assistant block other than plain text.
 *  Same surface treatment as the existing confirm card so visual hierarchy
 *  stays consistent across block types. */
export function BlockCard({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

/** Header row for cards — title + optional small subtitle (period_label,
 *  date range, etc). */
export function BlockHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <View style={styles.header}>
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
}

/** Big-number area below the header. Optional label above the amount, optional
 *  delta pill below. */
export function HeadlineAmount({
  label,
  amount,
  delta,
}: {
  label?: string;
  amount: string;
  delta?: { value: string; direction: "up" | "down" };
}) {
  return (
    <View style={styles.headline}>
      {label ? <Text style={styles.headlineLabel}>{label}</Text> : null}
      <Text style={styles.headlineAmount}>{amount}</Text>
      {delta ? <DeltaPill value={delta.value} direction={delta.direction} /> : null}
    </View>
  );
}

/** Small badge — "↑ 12%" or "↓ $4.50" — colored by direction. */
export function DeltaPill({
  value,
  direction,
}: {
  value: string;
  direction: "up" | "down";
}) {
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
  isLast,
}: {
  label: string;
  amount: string;
  sub?: string;
  barPct?: number;
  delta?: { value: string; direction: "up" | "down" };
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
        </View>
        <View style={styles.rowRight}>
          <Text style={styles.rowAmount}>{amount}</Text>
          {delta ? (
            <DeltaPill value={delta.value} direction={delta.direction} />
          ) : null}
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
  header: {
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
