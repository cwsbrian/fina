import { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import type { PresentationBlock } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";
import {
  BlockCard,
  BlockHeader,
  BlockFooter,
  BlockEmpty,
  currencySymbol,
} from "./_primitives";

type Block = Extract<PresentationBlock, { type: "scheduled_list" }>;
type Row = Block["rows"][number];

type Props = {
  block: Block;
  /** Consume the dismiss intent (runs dismissScheduledSpend server-side). */
  onSubmitForm?: (intentId: string, overrides: Record<string, unknown>) => Promise<void>;
};

export function ScheduledListBlock({ block, onSubmitForm }: Props) {
  const sym = currencySymbol(block.currency);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const rows = block.rows.filter((r) => !dismissed.has(r.id));

  return (
    <BlockCard>
      <BlockHeader
        title={block.title}
        {...(block.period_label ? { subtitle: block.period_label } : {})}
      />
      {rows.length === 0 ? (
        <BlockEmpty text="Nothing scheduled." />
      ) : (
        <View style={{ marginTop: space.xs }}>
          {rows.map((r, i) => {
            const intentId = r.dismiss_intent;
            const dismissHandler =
              intentId && onSubmitForm
                ? async () => {
                    setDismissed((prev) => new Set(prev).add(r.id));
                    try {
                      await onSubmitForm(intentId, {});
                    } catch {
                      /* keep optimistic */
                    }
                  }
                : undefined;
            return (
              <ScheduledRow
                key={r.id}
                row={r}
                sym={sym}
                isLast={i === rows.length - 1}
                {...(dismissHandler ? { onDismiss: dismissHandler } : {})}
              />
            );
          })}
        </View>
      )}
      {block.footer ? <BlockFooter text={block.footer} /> : null}
    </BlockCard>
  );
}

function ScheduledRow({
  row,
  sym,
  isLast,
  onDismiss,
}: {
  row: Row;
  sym: string;
  isLast: boolean;
  onDismiss?: () => void | Promise<void>;
}) {
  return (
    <View style={[styles.row, !isLast && styles.rowBorder]}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.name} numberOfLines={1}>
          {row.name}
        </Text>
        <Text style={styles.date} numberOfLines={1}>
          {row.scheduled_date}
        </Text>
      </View>
      <View style={styles.right}>
        <Text style={styles.amount}>
          {sym}
          {row.amount}
        </Text>
        {onDismiss ? (
          <Pressable
            onPress={onDismiss}
            style={({ pressed }) => [styles.dismiss, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.dismissText}>Dismiss</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 10,
    gap: space.sm,
  },
  rowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  name: {
    ...type$.bodyMd,
    color: colors.ink,
    fontWeight: "500",
  },
  date: {
    ...type$.caption,
    color: colors.muted,
    marginTop: 1,
  },
  right: {
    alignItems: "flex-end",
    gap: 4,
  },
  amount: {
    ...type$.bodyMd,
    color: colors.ink,
    fontVariant: ["tabular-nums"],
  },
  dismiss: {
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  dismissText: {
    ...type$.caption,
    color: colors.body,
    fontWeight: "600",
  },
});
