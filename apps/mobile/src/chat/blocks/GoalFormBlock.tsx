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
import {
  minDueDateOneMonthUTC,
  isDueDateAtLeastOneMonth,
  GOAL_TITLE_MAX_LEN,
  GOAL_MAX_AMOUNT,
} from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";
import { useDatePickerSheet } from "../../datetime/DatePickerSheetHost";
import { BlockCard, currencySymbol } from "./_primitives";

type Block = Extract<PresentationBlock, { type: "goal_form_card" }>;

type Props = {
  block: Block;
  onSubmit: (intentId: string, overrides: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
  onFocusChange?: (focused: boolean) => void;
};

const AMOUNT_RE = /^\d+(\.\d{0,2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

function floorDateStr(): string {
  return minDueDateOneMonthUTC().toISOString().slice(0, 10);
}

export function GoalFormBlock({ block, onSubmit, onCancel, onFocusChange }: Props) {
  const datePicker = useDatePickerSheet();
  const sym = currencySymbol(block.currency);
  const [title, setTitle] = useState<string>(block.defaults.title ?? "");
  const [amount, setAmount] = useState<string>(block.defaults.target_amount ?? "");
  const [dateStr, setDateStr] = useState<string>(block.defaults.due_date ?? floorDateStr());
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);

  useEffect(() => {
    onFocusChange?.(inputFocused);
    return () => onFocusChange?.(false);
  }, [inputFocused, onFocusChange]);

  const titleValid = title.trim().length > 0 && title.trim().length <= GOAL_TITLE_MAX_LEN;
  const amountValid =
    amount.length > 0 &&
    AMOUNT_RE.test(amount) &&
    parseFloat(amount) > 0 &&
    parseFloat(amount) <= GOAL_MAX_AMOUNT;
  // Mirror the server floor: due date must be >= one month from today.
  const dateValid = DATE_RE.test(dateStr) && isDueDateAtLeastOneMonth(dateStr);
  const canSubmit = !submitting && !done && titleValid && amountValid && dateValid;

  const dateValue = useMemo(() => {
    if (!DATE_RE.test(dateStr)) return new Date();
    const [y, mo, d] = dateStr.split("-").map(Number) as [number, number, number];
    return new Date(Date.UTC(y, mo - 1, d, 12));
  }, [dateStr]);

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const overrides: Record<string, unknown> = {
        title: title.trim(),
        target_amount: parseFloat(amount),
        due_date: dateStr,
      };
      await onSubmit(block.intent_id, overrides);
      setDone(true);
    } catch (e) {
      const code = (e as { code?: string }).code;
      Alert.alert(
        "Couldn't save",
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

  if (done) {
    return (
      <BlockCard>
        <View style={styles.doneRow}>
          <View style={styles.doneCheck}>
            <Ionicons name="checkmark" size={16} color={colors.onPrimary} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.doneName}>{title.trim()}</Text>
            <Text style={styles.doneMeta} numberOfLines={1}>By {dateStr}</Text>
          </View>
          <Text style={styles.doneAmount}>{sym}{formatAmount(amount)}</Text>
        </View>
      </BlockCard>
    );
  }
  if (cancelled) {
    return (
      <BlockCard>
        <Text style={styles.cancelledText}>{title.trim() || block.defaults.title || "Goal"} — cancelled</Text>
      </BlockCard>
    );
  }

  return (
    <BlockCard>
      <View style={styles.field}>
        <Text style={styles.label}>Goal</Text>
        <TextInput
          style={[styles.input, styles.nameInput]}
          value={title}
          onChangeText={setTitle}
          editable={!submitting}
          maxLength={GOAL_TITLE_MAX_LEN}
          autoCapitalize="words"
          returnKeyType="done"
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Target</Text>
        <View style={styles.amountRow}>
          <Text style={styles.amountPrefix}>{sym}</Text>
          <TextInput
            style={[styles.input, styles.amountInput]}
            value={amount}
            onChangeText={(t) => setAmount(t.replace(/[^0-9.]/g, ""))}
            keyboardType="decimal-pad"
            placeholder="0.00"
            placeholderTextColor={colors.muted}
            editable={!submitting}
            returnKeyType="done"
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
          />
        </View>
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Target date</Text>
        <Pressable
          style={styles.dateBtn}
          onPress={() => {
            if (submitting) return;
            datePicker.open(
              dateValue,
              (next) => {
                const y = next.getUTCFullYear();
                const mo = String(next.getUTCMonth() + 1).padStart(2, "0");
                const d = String(next.getUTCDate()).padStart(2, "0");
                setDateStr(`${y}-${mo}-${d}`);
              },
              { minimumDate: minDueDateOneMonthUTC(), maximumDate: new Date(Date.now() + TEN_YEARS_MS) },
            );
          }}
        >
          <Text style={styles.dateBtnText}>{dateStr || "Pick a date"}</Text>
        </Pressable>
      </View>

      <View style={styles.actions}>
        <Pressable style={[styles.btn, styles.btnCancel]} onPress={cancel} disabled={submitting}>
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
            <Text style={styles.btnSubmitText}>{block.mode === "update" ? "Update" : "Add goal"}</Text>
          )}
        </Pressable>
      </View>
    </BlockCard>
  );
}

function formatAmount(s: string): string {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n.toFixed(2) : s;
}

const styles = StyleSheet.create({
  field: { marginTop: space.sm },
  label: { ...type$.caption, color: colors.muted, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 },
  amountRow: { flexDirection: "row", alignItems: "center", backgroundColor: colors.surfaceSoft, borderRadius: 10, paddingHorizontal: 12 },
  amountPrefix: { ...type$.bodyMd, color: colors.muted, marginRight: 4 },
  amountInput: { flex: 1 },
  input: { paddingVertical: 10, color: colors.ink, fontSize: 16 },
  nameInput: { backgroundColor: colors.surfaceSoft, borderRadius: 10, paddingHorizontal: 12 },
  dateBtn: { paddingVertical: 12, paddingHorizontal: 12, backgroundColor: colors.surfaceSoft, borderRadius: 10 },
  dateBtnText: { ...type$.bodyMd, color: colors.ink },
  actions: { flexDirection: "row", gap: space.xs, marginTop: space.base },
  btn: { flex: 1, paddingVertical: 12, borderRadius: 999, alignItems: "center" },
  btnCancel: { backgroundColor: colors.canvas, borderWidth: 1, borderColor: colors.hairline },
  btnSubmit: { backgroundColor: colors.primary },
  btnDisabled: { backgroundColor: colors.primaryDisabled },
  btnCancelText: { ...type$.button, color: colors.ink },
  btnSubmitText: { ...type$.button, color: colors.onPrimary },
  doneRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 4 },
  doneCheck: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  doneName: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  doneMeta: { ...type$.caption, color: colors.muted, marginTop: 2 },
  doneAmount: { ...type$.bodyMd, color: colors.ink, fontVariant: ["tabular-nums"], fontWeight: "500" },
  cancelledText: { ...type$.bodySm, color: colors.muted, fontStyle: "italic" },
});
