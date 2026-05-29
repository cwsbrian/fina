import { View, Text, StyleSheet } from "react-native";
import type { PresentationBlock, PlaidItemStatus } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";
import { BlockCard, BlockHeader, BlockFooter, BlockEmpty, currencySymbol } from "./_primitives";

type Block = Extract<PresentationBlock, { type: "accounts_list" }>;

/** Plaid status → badge label + tone. null/active = no badge. */
function statusBadge(status: PlaidItemStatus | null | undefined): { label: string; color: string } | null {
  switch (status) {
    case "error": return { label: "Error", color: colors.down };
    case "relink_required": return { label: "Reconnect", color: colors.down };
    case "disconnected": return { label: "Disconnected", color: colors.muted };
    default: return null;
  }
}

export function AccountsListBlock({ block }: { block: Block }) {
  const sym = currencySymbol(block.currency);
  return (
    <BlockCard>
      <BlockHeader title={block.title} />
      {block.total_balance != null ? (
        <Text style={styles.total}>
          <Text style={styles.totalAmount}>{sym}{block.total_balance}</Text>
          <Text style={styles.totalSub}> total</Text>
        </Text>
      ) : null}
      {block.rows.length === 0 ? (
        <BlockEmpty text="No accounts connected." />
      ) : (
        <View style={{ marginTop: space.xs }}>
          {block.rows.map((r, i) => {
            const badge = statusBadge(r.status);
            return (
              <View key={r.id} style={[styles.row, i < block.rows.length - 1 && styles.rowBorder]}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.name} numberOfLines={1}>{r.name}</Text>
                  {r.institution ? <Text style={styles.inst} numberOfLines={1}>{r.institution}</Text> : null}
                </View>
                <View style={styles.right}>
                  {r.balance != null ? <Text style={styles.bal}>{sym}{r.balance}</Text> : null}
                  {badge ? <Text style={[styles.badge, { color: badge.color }]}>{badge.label}</Text> : null}
                </View>
              </View>
            );
          })}
        </View>
      )}
      {block.footer ? <BlockFooter text={block.footer} /> : null}
    </BlockCard>
  );
}

const styles = StyleSheet.create({
  total: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  totalAmount: { color: colors.ink, fontWeight: "600", fontVariant: ["tabular-nums"] },
  totalSub: { color: colors.muted },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 10, gap: space.sm },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.hairlineSoft },
  name: { ...type$.bodyMd, color: colors.ink, fontWeight: "500" },
  inst: { ...type$.caption, color: colors.muted, marginTop: 1 },
  right: { alignItems: "flex-end", gap: 2 },
  bal: { ...type$.bodyMd, color: colors.ink, fontVariant: ["tabular-nums"] },
  badge: { ...type$.caption, fontWeight: "600" },
});
