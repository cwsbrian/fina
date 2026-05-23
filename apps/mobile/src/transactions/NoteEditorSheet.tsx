import { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Alert,
  TextInput,
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
  /** Current note value — the editor opens pre-populated with this. */
  initialNote: string | null;
  /** Fired on backdrop tap, drag-down, or Cancel. */
  onClose: () => void;
  /** Fired after a successful save with the new note (null when cleared). */
  onSaved: (next: string | null) => void;
};

/** Bottom sheet editor for a transaction note. Tap to open → edit → Save
 *  commits via PATCH and closes. Cancel discards changes. */
export function NoteEditorSheet({
  visible,
  txId,
  initialNote,
  onClose,
  onSaved,
}: Props) {
  const ref = useRef<BottomSheet>(null);
  const inputRef = useRef<TextInput>(null);
  const [draft, setDraft] = useState(initialNote ?? "");
  const [saving, setSaving] = useState(false);

  const snapPoints = useMemo(() => ["90%"], []);

  useEffect(() => {
    if (visible) {
      setDraft(initialNote ?? "");
      // Focus next frame so the sheet's open animation can land first.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [visible, initialNote]);

  const save = async () => {
    setSaving(true);
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) throw new Error("no_workspace");
      const trimmed = draft.trim();
      const next: string | null = trimmed.length === 0 ? null : trimmed;
      await apiFetch(`/workspaces/${wsId}/transactions/${txId}`, {
        method: "PATCH",
        body: JSON.stringify({ note: next }),
      });
      ref.current?.close();
      onSaved(next);
    } catch (e) {
      Alert.alert(
        "Couldn't save note",
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
      keyboardBehavior="fillParent"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
    >
      <BottomSheetView style={styles.body}>
        <View style={styles.head}>
          <Pressable
            style={({ pressed }) => [
              styles.actionBtn,
              pressed && { opacity: 0.6 },
            ]}
            onPress={() => ref.current?.close()}
            disabled={saving}
            hitSlop={8}
          >
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>Note</Text>
          <Pressable
            style={({ pressed }) => [
              styles.actionBtn,
              (pressed || saving) && { opacity: 0.6 },
            ]}
            onPress={save}
            disabled={saving}
            hitSlop={8}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Text style={styles.save}>Save</Text>
            )}
          </Pressable>
        </View>

        <TextInput
          ref={inputRef}
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Add a note"
          placeholderTextColor={colors.mutedSoft}
          multiline
          editable={!saving}
          textAlignVertical="top"
        />
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
  body: { flex: 1, paddingHorizontal: space.lg, paddingBottom: space.lg },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: space.sm,
  },
  title: { ...type$.titleSm, color: colors.ink, fontWeight: "600" },
  actionBtn: { minWidth: 60, alignItems: "center", justifyContent: "center" },
  cancel: { ...type$.bodyMd, color: colors.muted },
  save: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },
  input: {
    flex: 1,
    ...type$.bodyMd,
    color: colors.ink,
    padding: space.base,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 14,
    minHeight: 120,
  },
});
