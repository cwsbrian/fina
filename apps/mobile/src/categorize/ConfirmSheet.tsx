import { useCallback, useEffect, useMemo, useRef } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import BottomSheet, { BottomSheetView } from "@gorhom/bottom-sheet";
import { apiFetch } from "../api/client";
import { colors, space, type as type$ } from "../design/tokens";

export type ConfirmSheetTarget = {
  workspaceId: string;
  txId: string;
  merchant: string;
  categoryName: string;
};

export function ConfirmSheet({
  target,
  onClose,
  onConfirmed,
  onEditPress,
}: {
  target: ConfirmSheetTarget | null;
  onClose: () => void;
  onConfirmed: () => void;
  onEditPress: (target: ConfirmSheetTarget) => void;
}) {
  const ref = useRef<BottomSheet>(null);
  const snapPoints = useMemo(() => ["28%"], []);
  const explicitChoice = useRef(false);

  useEffect(() => {
    if (target) {
      explicitChoice.current = false;
      ref.current?.expand();
    } else {
      ref.current?.close();
    }
  }, [target]);

  const onChange = useCallback(
    async (index: number) => {
      if (index === -1 && target && !explicitChoice.current) {
        try {
          await apiFetch(
            `/workspaces/${target.workspaceId}/transactions/${target.txId}/snooze-category`,
            { method: "POST" },
          );
        } catch {
          // swallow — UI continues, snooze is best-effort
        }
        onClose();
      }
    },
    [target, onClose],
  );

  if (!target) return null;

  async function confirm() {
    explicitChoice.current = true;
    try {
      await apiFetch(
        `/workspaces/${target!.workspaceId}/transactions/${target!.txId}/confirm-category`,
        { method: "POST" },
      );
      onConfirmed();
    } catch {
      // best-effort
    }
    ref.current?.close();
  }

  function pickOther() {
    explicitChoice.current = true;
    onEditPress(target!);
    ref.current?.close();
  }

  return (
    <BottomSheet
      ref={ref}
      index={-1}
      snapPoints={snapPoints}
      enablePanDownToClose
      onChange={onChange}
    >
      <BottomSheetView style={styles.body}>
        <Text style={styles.q}>
          {target.merchant} → {target.categoryName} 이 맞아요?
        </Text>
        <View style={styles.row}>
          <Pressable style={[styles.btn, styles.btnPrimary]} onPress={confirm}>
            <Text style={styles.btnPrimaryText}>Confirm</Text>
          </Pressable>
          <Pressable style={[styles.btn, styles.btnGhost]} onPress={pickOther}>
            <Text style={styles.btnGhostText}>다른 카테고리</Text>
          </Pressable>
        </View>
      </BottomSheetView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.base },
  q: { ...type$.titleSm, color: colors.ink, textAlign: "center" },
  row: { flexDirection: "row", gap: space.sm },
  btn: {
    flex: 1,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
  },
  btnPrimary: { backgroundColor: colors.primary },
  btnPrimaryText: { ...type$.bodyMd, color: colors.onPrimary, fontWeight: "600" },
  btnGhost: { borderWidth: 1, borderColor: colors.hairline },
  btnGhostText: { ...type$.bodyMd, color: colors.ink },
});
