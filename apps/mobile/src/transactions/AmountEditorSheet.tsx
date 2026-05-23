import { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ActivityIndicator,
  Alert,
  Keyboard,
  Platform,
} from "react-native";
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { apiFetch } from "../api/client";
import { getActiveWorkspaceId } from "../workspace/active";
import { colors, space, type as type$ } from "../design/tokens";

type Props = {
  visible: boolean;
  txId: string;
  /** Current signed amount as stored on the tx — string like "12.34" or
   *  "-50.00". Negative = income (Plaid convention). */
  initial: string;
  /** Sheet dismiss callback. */
  onClose: () => void;
  /** Fires after a successful PATCH with the new signed amount string. */
  onSaved: (next: string) => void;
};

type Kind = "expense" | "income";

/** Bottom sheet for editing a manual transaction's amount + sign. */
export function AmountEditorSheet({
  visible,
  txId,
  initial,
  onClose,
  onSaved,
}: Props) {
  const ref = useRef<BottomSheet>(null);
  const inputRef = useRef<TextInput>(null);

  const initialNum = Number(initial);
  const [kind, setKind] = useState<Kind>(initialNum < 0 ? "income" : "expense");
  const [draft, setDraft] = useState(
    Number.isFinite(initialNum) ? Math.abs(initialNum).toFixed(2) : "",
  );
  const [saving, setSaving] = useState(false);
  const [kbHeight, setKbHeight] = useState(0);

  // Same sheet-hugs-keyboard trick as the note editor — height grows
  // with the keyboard so the input sits just above it.
  const CONTENT_HEIGHT_PX = 240;
  const CLOSED_HEIGHT_PX = 260;
  const snapPoints = useMemo(
    () => [kbHeight > 0 ? CONTENT_HEIGHT_PX + kbHeight : CLOSED_HEIGHT_PX],
    [kbHeight],
  );

  useEffect(() => {
    if (visible) {
      const n = Number(initial);
      setKind(n < 0 ? "income" : "expense");
      setDraft(Number.isFinite(n) ? Math.abs(n).toFixed(2) : "");
      inputRef.current?.focus();
    }
  }, [visible, initial]);

  useEffect(() => {
    const showEvt = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvt = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvt, (e) => {
      setKbHeight(e.endCoordinates.height);
    });
    const hide = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const save = async () => {
    const n = Number(draft);
    if (!Number.isFinite(n) || n <= 0) return;
    const signed = kind === "income" ? -Math.abs(n) : Math.abs(n);
    setSaving(true);
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) throw new Error("no_workspace");
      await apiFetch(`/workspaces/${wsId}/transactions/${txId}`, {
        method: "PATCH",
        body: JSON.stringify({ amount: signed }),
      });
      Keyboard.dismiss();
      ref.current?.close();
      onSaved(signed.toFixed(2));
    } catch (e) {
      Alert.alert(
        "Couldn't save",
        (e as { code?: string }).code ?? "Try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  const renderBackdrop = (props: BottomSheetBackdropProps) => (
    <BottomSheetBackdrop
      {...props}
      appearsOnIndex={0}
      disappearsOnIndex={-1}
      opacity={0.35}
      pressBehavior="close"
    />
  );

  return (
    <BottomSheet
      ref={ref}
      snapPoints={snapPoints}
      enableDynamicSizing={false}
      index={visible ? 0 : -1}
      backdropComponent={renderBackdrop}
      onClose={onClose}
      handleIndicatorStyle={styles.grabber}
      backgroundStyle={styles.background}
      enablePanDownToClose
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
    >
      <BottomSheetView style={styles.body}>
        <View style={styles.head}>
          <Pressable
            onPress={() => {
              Keyboard.dismiss();
              ref.current?.close();
            }}
            disabled={saving}
            hitSlop={8}
          >
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>Amount</Text>
          <Pressable
            onPress={save}
            disabled={saving || Number(draft) <= 0}
            hitSlop={8}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Text
                style={[
                  styles.save,
                  (saving || Number(draft) <= 0) && { opacity: 0.5 },
                ]}
              >
                Save
              </Text>
            )}
          </Pressable>
        </View>

        <View style={styles.seg}>
          <Pressable
            style={[styles.segOpt, kind === "expense" && styles.segActive]}
            onPress={() => setKind("expense")}
            disabled={saving}
          >
            <Text
              style={[
                styles.segText,
                kind === "expense" && styles.segTextActive,
              ]}
            >
              Expense
            </Text>
          </Pressable>
          <Pressable
            style={[styles.segOpt, kind === "income" && styles.segActive]}
            onPress={() => setKind("income")}
            disabled={saving}
          >
            <Text
              style={[
                styles.segText,
                kind === "income" && styles.segTextActive,
              ]}
            >
              Income
            </Text>
          </Pressable>
        </View>

        <View style={styles.row}>
          <Text
            style={[
              styles.adornment,
              kind === "income" && { color: colors.up },
            ]}
          >
            {kind === "income" ? "+" : "−"}
          </Text>
          <Text
            style={[
              styles.adornment,
              kind === "income" && { color: colors.up },
              { marginRight: 2 },
            ]}
          >
            $
          </Text>
          <TextInput
            ref={inputRef}
            style={[
              styles.input,
              kind === "income" && { color: colors.up },
            ]}
            value={draft}
            onChangeText={(v) => {
              if (/^\d*\.?\d{0,2}$/.test(v)) setDraft(v);
            }}
            placeholder="0"
            placeholderTextColor={colors.mutedSoft}
            keyboardType="decimal-pad"
            editable={!saving}
            autoFocus
          />
        </View>
      </BottomSheetView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  background: {
    backgroundColor: colors.canvas,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  grabber: { backgroundColor: colors.mutedSoft, width: 36, height: 4 },
  body: { flex: 1, paddingHorizontal: space.lg },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: space.sm,
  },
  title: { ...type$.titleSm, color: colors.ink, fontWeight: "600" },
  cancel: { ...type$.bodyMd, color: colors.muted },
  save: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },
  seg: {
    flexDirection: "row",
    backgroundColor: colors.surfaceSoft,
    borderRadius: 999,
    padding: 4,
    marginTop: space.sm,
    marginBottom: space.lg,
  },
  segOpt: {
    flex: 1,
    paddingVertical: 8,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
  },
  segActive: { backgroundColor: colors.canvas },
  segText: { ...type$.bodyMd, color: colors.muted, fontWeight: "600" },
  segTextActive: { color: colors.ink },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  adornment: { fontSize: 30, fontWeight: "500", color: colors.ink },
  input: {
    fontSize: 48,
    fontWeight: "500",
    letterSpacing: -1.2,
    color: colors.ink,
    minWidth: 100,
    paddingTop: 8,
    paddingBottom: 4,
  },
});
