import { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import type { PresentationBlock } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";
import { BlockCard, BlockHeader, BlockFooter, BlockEmpty, currencySymbol } from "./_primitives";
import { RecurringFormBlock } from "./RecurringFormBlock";

type Block = Extract<PresentationBlock, { type: "recurring_candidates" }>;
type Row = Block["rows"][number];
type FormCard = Extract<PresentationBlock, { type: "recurring_form_card" }>;

type Props = {
  block: Block;
  onSubmitForm?: (intentId: string, overrides: Record<string, unknown>) => Promise<void>;
  onFormFocusChange?: (focused: boolean) => void;
};

function cadenceLabel(c: Row["cadence"]): string {
  switch (c) {
    case "monthly": return "mo";
    case "semimonthly": return "½ mo";
    case "biweekly": return "2 wk";
    case "weekly": return "wk";
    case "yearly": return "yr";
  }
}

/** Build the synthetic recurring_form_card the existing form renderer expects. */
function toFormCard(row: Row, currency: string | undefined): FormCard {
  return {
    type: "recurring_form_card",
    question: `Add ${row.merchant} as a recurring expense?`,
    intent_id: row.add_form_intent,
    defaults: row.defaults,
    currency: currency ?? "CAD",
    mode: "add",
  };
}

export function RecurringCandidatesBlock({ block, onSubmitForm, onFormFocusChange }: Props) {
  const sym = currencySymbol(block.currency);
  const [openIntent, setOpenIntent] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  return (
    <BlockCard>
      <BlockHeader title={block.title} />
      {block.rows.length === 0 ? (
        <BlockEmpty text="No recurring patterns detected." />
      ) : (
        <View style={{ marginTop: space.xs }}>
          {block.rows.map((r, i) => {
            const isOpen = openIntent === r.add_form_intent;
            if (isOpen) {
              return (
                <View key={r.add_form_intent} style={styles.formWrap}>
                  <RecurringFormBlock
                    block={toFormCard(r, block.currency)}
                    onSubmit={async (id, overrides) => {
                      if (onSubmitForm) await onSubmitForm(id, overrides);
                      setAdded((prev) => new Set(prev).add(r.add_form_intent));
                      setOpenIntent(null);
                    }}
                    onCancel={() => setOpenIntent(null)}
                    {...(onFormFocusChange ? { onFocusChange: onFormFocusChange } : {})}
                  />
                </View>
              );
            }
            return (
              <View key={r.add_form_intent} style={[styles.row, i < block.rows.length - 1 && styles.rowBorder]}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.name} numberOfLines={1}>{r.merchant}</Text>
                  <Text style={styles.sub} numberOfLines={1}>
                    {sym}{r.amount} / {cadenceLabel(r.cadence)} · seen {r.occurrences}×
                  </Text>
                </View>
                {added.has(r.add_form_intent) ? (
                  <Text style={styles.addedText}>Added</Text>
                ) : onSubmitForm ? (
                  <Pressable onPress={() => setOpenIntent(r.add_form_intent)} style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.85 }]}>
                    <Text style={styles.addBtnText}>Add</Text>
                  </Pressable>
                ) : null}
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
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 10, gap: space.sm },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.hairlineSoft },
  name: { ...type$.bodyMd, color: colors.ink, fontWeight: "500" },
  sub: { ...type$.caption, color: colors.muted, marginTop: 1 },
  addBtn: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 999, backgroundColor: colors.primary },
  addBtnText: { ...type$.button, color: colors.onPrimary },
  addedText: { ...type$.caption, color: colors.muted, fontWeight: "600" },
  formWrap: { paddingVertical: space.xs },
});
