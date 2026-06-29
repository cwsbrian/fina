import { View, Text, Pressable, StyleSheet } from "react-native";
import type { PresentationBlock } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";

type PlanCard = Extract<PresentationBlock, { type: "plan_proposal_card" }>;

export function PlanProposalCardBlock({
  block,
  presentation = "card",
  onAccept,
  onReject,
}: {
  block: PlanCard;
  presentation?: "card" | "sheet";
  onAccept?: (intent: string) => void;
  onReject?: (intent: string | undefined) => void;
}) {
  return (
    <View style={presentation === "sheet" ? styles.sheet : styles.card}>
      <Text style={styles.question}>{block.question}</Text>
      {block.rows.map((r, i) => (
        <View key={i} style={styles.row}>
          <Text style={styles.rowLeft} numberOfLines={1}>{r.date} · {r.category}</Text>
          <Text style={styles.rowAmount}>{r.amount}</Text>
        </View>
      ))}
      <View style={styles.totalRow}>
        <Text style={styles.totalLabel}>Total</Text>
        <Text style={styles.totalAmount}>{block.total}</Text>
      </View>
      {presentation === "sheet" ? null : (
        <View style={styles.actions}>
          <Pressable style={({ pressed }) => [styles.btn, styles.reject, pressed && { opacity: 0.7 }]} onPress={() => onReject?.(block.reject_intent)}>
            <Text style={styles.rejectText}>{block.reject_label}</Text>
          </Pressable>
          <Pressable style={({ pressed }) => [styles.btn, styles.accept, pressed && { opacity: 0.85 }]} onPress={() => onAccept?.(block.accept_intent)}>
            <Text style={styles.acceptText}>{block.accept_label}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.canvas, borderWidth: 1, borderColor: colors.hairline, borderRadius: 16, padding: space.base, marginVertical: 4, gap: space.xs },
  sheet: { gap: space.xs },
  question: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  row: { flexDirection: "row", justifyContent: "space-between", gap: space.sm },
  rowLeft: { ...type$.bodySm, color: colors.body, flex: 1, minWidth: 0 },
  rowAmount: { ...type$.bodySm, color: colors.ink, fontVariant: ["tabular-nums"] },
  totalRow: { flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: colors.hairline, paddingTop: space.xs, marginTop: 2 },
  totalLabel: { ...type$.caption, color: colors.muted, textTransform: "uppercase" },
  totalAmount: { ...type$.bodyMd, color: colors.ink, fontWeight: "600", fontVariant: ["tabular-nums"] },
  actions: { flexDirection: "row", gap: space.sm, marginTop: space.xs },
  btn: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: "center" },
  reject: { backgroundColor: colors.hairline },
  accept: { backgroundColor: colors.primary },
  rejectText: { ...type$.bodyMd, color: colors.body, fontWeight: "600" },
  acceptText: { ...type$.bodyMd, color: colors.onPrimary, fontWeight: "600" },
});
