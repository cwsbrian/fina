import { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ActivityIndicator,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { PresentationBlock } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";
import { useDatePickerSheet } from "../../datetime/DatePickerSheetHost";
import { BlockCard } from "./_primitives";

type Block = Extract<PresentationBlock, { type: "recurring_form_card" }>;
type Cadence = NonNullable<Block["defaults"]["cadence"]>;

type Props = {
  block: Block;
  onSubmit: (intentId: string, overrides: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
  /** Called when any of the form inputs gains/loses focus so the parent
   *  can hide the chat composer while the user is filling in the form. */
  onFocusChange?: (focused: boolean) => void;
};

const CADENCE_OPTIONS: Array<{ key: Cadence; label: string }> = [
  { key: "monthly",     label: "Monthly" },
  { key: "semimonthly", label: "Semi-mo" },
  { key: "biweekly",    label: "Biweekly" },
  { key: "weekly",      label: "Weekly" },
  { key: "yearly",      label: "Yearly" },
];

const AMOUNT_RE = /^\d+(\.\d{0,2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Inline form for adding a recurring expense. LLM seeds defaults; user
 *  edits and submits — no further back-and-forth with the assistant. */
export function RecurringFormBlock({ block, onSubmit, onCancel, onFocusChange }: Props) {
  const datePicker = useDatePickerSheet();
  const [name, setName] = useState<string>(block.defaults.name);
  const [amount, setAmount] = useState<string>(block.defaults.amount ?? "");
  const [cadence, setCadence] = useState<Cadence>(block.defaults.cadence ?? "monthly");
  const [dateStr, setDateStr] = useState<string>(
    block.defaults.next_occurrence_date ?? defaultNextDate(block.defaults.cadence ?? "monthly"),
  );
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  // Tell the parent when the form is "in use" so the chat composer can
  // step out of the way. We consider the form in-use while it's still
  // editable; done/cancelled re-shows the composer.
  useEffect(() => {
    onFocusChange?.(!done && !cancelled);
    return () => {
      onFocusChange?.(false);
    };
  }, [done, cancelled, onFocusChange]);

  const nameValid = name.trim().length > 0 && name.trim().length <= 100;
  const amountValid = amount.length > 0 && AMOUNT_RE.test(amount) && parseFloat(amount) > 0;
  const dateValid = DATE_RE.test(dateStr);
  const canSubmit = !submitting && !done && nameValid && amountValid && dateValid;

  const dateValue = useMemo(() => {
    const m = DATE_RE.exec(dateStr);
    if (!m) return new Date();
    const [y, mo, d] = dateStr.split("-").map(Number) as [number, number, number];
    return new Date(Date.UTC(y, mo - 1, d, 12));
  }, [dateStr]);

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const overrides: Record<string, unknown> = {
        name: name.trim(),
        amount: parseFloat(amount),
        cadence,
        next_occurrence_date: dateStr,
      };
      await onSubmit(block.intent_id, overrides);
      setDone(true);
    } catch (e) {
      const code = (e as { code?: string }).code;
      Alert.alert(
        "Couldn't add",
        code === "intent_gone"
          ? "This form expired. Ask Fina to set it up again."
          : code ?? "Try again in a moment.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = () => {
    if (submitting || done) return;
    onCancel();
    setCancelled(true);
  };

  // Post-submit: render the form as a single row of resolved values,
  // styled like a recurring_list row. No editable fields visible.
  if (done) {
    return (
      <BlockCard>
        <View style={styles.doneRow}>
          <View style={styles.doneCheck}>
            <Ionicons name="checkmark" size={16} color={colors.onPrimary} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.doneName}>{name.trim()}</Text>
            <Text style={styles.doneMeta} numberOfLines={1}>
              {cadenceLongLabel(cadence)} · Next {prettyDate(dateStr)}
            </Text>
          </View>
          <Text style={styles.doneAmount}>
            ${formatAmount(amount)} / {cadenceShortLabel(cadence)}
          </Text>
        </View>
      </BlockCard>
    );
  }
  if (cancelled) {
    return (
      <BlockCard>
        <Text style={styles.cancelledText}>{name.trim() || block.defaults.name} — cancelled</Text>
      </BlockCard>
    );
  }

  // Don't render block.question inside the card — the LLM emits it
  // again as a sibling text bubble above this card, so showing it here
  // is a visible duplicate. The bubble is the question; the card is
  // the answer surface.
  return (
    <BlockCard>
      <View style={styles.field}>
        <Text style={styles.label}>Name</Text>
        <TextInput
          style={[styles.input, styles.nameInput]}
          value={name}
          onChangeText={setName}
          editable={!submitting}
          maxLength={100}
          autoCapitalize="words"
          returnKeyType="done"
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Amount</Text>
        <View style={styles.amountRow}>
          <Text style={styles.amountPrefix}>$</Text>
          <TextInput
            style={[styles.input, styles.amountInput]}
            value={amount}
            onChangeText={(t) => setAmount(t.replace(/[^0-9.]/g, ""))}
            keyboardType="decimal-pad"
            placeholder="0.00"
            placeholderTextColor={colors.muted}
            editable={!submitting}
            returnKeyType="done"
          />
        </View>
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Cadence</Text>
        <View style={styles.segments}>
          {CADENCE_OPTIONS.map((opt) => {
            const selected = opt.key === cadence;
            return (
              <Pressable
                key={opt.key}
                style={[styles.segment, selected && styles.segmentSelected]}
                onPress={() => !submitting && setCadence(opt.key)}
              >
                <Text
                  style={[
                    styles.segmentText,
                    selected && styles.segmentTextSelected,
                  ]}
                  numberOfLines={1}
                >
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Next occurrence</Text>
        <Pressable
          style={styles.dateBtn}
          onPress={() => {
            if (submitting) return;
            datePicker.open(dateValue, (next) => {
              const y = next.getUTCFullYear();
              const mo = String(next.getUTCMonth() + 1).padStart(2, "0");
              const d = String(next.getUTCDate()).padStart(2, "0");
              setDateStr(`${y}-${mo}-${d}`);
            });
          }}
        >
          <Text style={styles.dateBtnText}>{dateStr || "Pick a date"}</Text>
        </Pressable>
      </View>

      <View style={styles.actions}>
        <Pressable
          style={[styles.btn, styles.btnCancel]}
          onPress={cancel}
          disabled={submitting}
        >
          <Text style={styles.btnCancelText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnSubmit, !canSubmit && styles.btnDisabled]}
          onPress={submit}
          disabled={!canSubmit}
        >
          {submitting ? (
            <ActivityIndicator size="small" color={colors.onPrimary} />
          ) : (
            <Text style={styles.btnSubmitText}>
              {block.mode === "update" ? "Update" : "Add"}
            </Text>
          )}
        </Pressable>
      </View>
    </BlockCard>
  );
}

function defaultNextDate(cadence: Cadence): string {
  const now = new Date();
  const out = new Date(now);
  switch (cadence) {
    case "weekly":      out.setDate(now.getDate() + 7);  break;
    case "biweekly":    out.setDate(now.getDate() + 14); break;
    case "semimonthly": out.setDate(now.getDate() + 15); break;
    case "monthly":     out.setMonth(now.getMonth() + 1); break;
    case "yearly":      out.setFullYear(now.getFullYear() + 1); break;
  }
  const y = out.getFullYear();
  const m = String(out.getMonth() + 1).padStart(2, "0");
  const d = String(out.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatAmount(s: string): string {
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return s;
  return n.toFixed(2);
}

function cadenceLongLabel(c: Cadence): string {
  switch (c) {
    case "monthly":     return "Monthly";
    case "semimonthly": return "Semi-monthly";
    case "biweekly":    return "Biweekly";
    case "weekly":      return "Weekly";
    case "yearly":      return "Yearly";
  }
}

function cadenceShortLabel(c: Cadence): string {
  switch (c) {
    case "monthly":     return "mo";
    case "semimonthly": return "½ mo";
    case "biweekly":    return "2 wk";
    case "weekly":      return "wk";
    case "yearly":      return "yr";
  }
}

function prettyDate(iso: string): string {
  const m = DATE_RE.exec(iso);
  if (!m) return iso;
  const [y, mo, d] = iso.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, mo - 1, d, 12));
  return dt.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

const styles = StyleSheet.create({
  question: { ...type$.titleSm, color: colors.ink, marginBottom: space.xs },
  field: { marginTop: space.sm },
  label: {
    ...type$.caption,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  staticValue: { ...type$.bodyMd, color: colors.ink, fontWeight: "500" },
  amountRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surfaceSoft,
    borderRadius: 10,
    paddingHorizontal: 12,
  },
  amountPrefix: { ...type$.bodyMd, color: colors.muted, marginRight: 4 },
  amountInput: { flex: 1 },
  input: { paddingVertical: 10, color: colors.ink, fontSize: 16 },
  nameInput: {
    backgroundColor: colors.surfaceSoft,
    borderRadius: 10,
    paddingHorizontal: 12,
  },
  segments: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  segment: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.canvas,
  },
  segmentSelected: { backgroundColor: colors.ink, borderColor: colors.ink },
  segmentText: { ...type$.bodySm, color: colors.body, fontWeight: "500" },
  segmentTextSelected: { color: colors.onDark, fontWeight: "600" },
  dateBtn: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 10,
  },
  dateBtnText: { ...type$.bodyMd, color: colors.ink },
  actions: { flexDirection: "row", gap: space.xs, marginTop: space.base },
  btn: { flex: 1, paddingVertical: 12, borderRadius: 999, alignItems: "center" },
  btnCancel: {
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  btnSubmit: { backgroundColor: colors.primary },
  btnDisabled: { backgroundColor: colors.primaryDisabled },
  btnCancelText: { ...type$.button, color: colors.ink },
  btnSubmitText: { ...type$.button, color: colors.onPrimary },
  // Post-submit "done" row
  doneRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 4 },
  doneCheck: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  doneName: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  doneMeta: { ...type$.caption, color: colors.muted, marginTop: 2 },
  doneAmount: { ...type$.bodyMd, color: colors.ink, fontVariant: ["tabular-nums"], fontWeight: "500" },
  cancelledText: { ...type$.bodySm, color: colors.muted, fontStyle: "italic" },
});
