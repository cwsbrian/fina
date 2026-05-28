import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  Alert,
  ActivityIndicator,
  Keyboard,
} from "react-native";
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { Ionicons } from "@expo/vector-icons";
import { colors, space, type as type$ } from "../design/tokens";
import { apiFetch } from "../api/client";

type Props = {
  visible: boolean;
  threadId: string;
  currentTitle: string | null;
  /** Workspace this thread is bound to. Read-only display — the user
   *  can't change the binding from here (changing a thread's workspace
   *  isn't supported; it's set at first send). `null` hides the row. */
  workspaceName: string | null;
  /** Called after a successful rename so the parent can update its
   *  header title without waiting for a thread reload. */
  onRenamed: (newTitle: string) => void;
  /** Called after a successful delete so the parent can navigate back
   *  to a fresh / pending thread. */
  onDeleted: () => void;
  onClose: () => void;
};

const TITLE_MAX = 80;

/** Bottom sheet shown when the user taps the thread title in the Chat
 *  header. Two actions: rename (inline TextInput + Save) and delete
 *  (with confirmation Alert). Closes itself on success. */
export function ThreadActionsSheet({
  visible,
  threadId,
  currentTitle,
  workspaceName,
  onRenamed,
  onDeleted,
  onClose,
}: Props) {
  const ref = useRef<BottomSheet>(null);
  const snapPoints = useMemo(() => ["44%"], []);
  const [draft, setDraft] = useState<string>(currentTitle ?? "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Re-prime the input whenever the sheet opens for a different title.
  // Also drop the chat composer's keyboard so the sheet animates in
  // over a settled screen instead of fighting a half-raised keyboard.
  useEffect(() => {
    if (visible) {
      setDraft(currentTitle ?? "");
      Keyboard.dismiss();
    }
  }, [visible, currentTitle]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={0.35}
        pressBehavior="close"
      />
    ),
    [],
  );

  const trimmed = draft.trim();
  const canSave =
    !saving && !deleting && trimmed.length > 0 && trimmed !== (currentTitle ?? "");

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const out = await apiFetch<{ thread: { title: string | null } }>(
        `/chat/threads/${threadId}`,
        { method: "PATCH", body: JSON.stringify({ title: trimmed }) },
      );
      onRenamed(out.thread.title ?? trimmed);
      onClose();
    } catch (e) {
      const code = (e as { code?: string }).code;
      Alert.alert("Couldn't rename", code ?? "Try again in a moment.");
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = () => {
    if (saving || deleting) return;
    Alert.alert(
      "Delete this chat?",
      "This conversation will be removed. You can't undo this.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: doDelete,
        },
      ],
    );
  };

  const doDelete = async () => {
    setDeleting(true);
    try {
      await apiFetch(`/chat/threads/${threadId}`, { method: "DELETE" });
      onDeleted();
      onClose();
    } catch (e) {
      const code = (e as { code?: string }).code;
      Alert.alert("Couldn't delete", code ?? "Try again in a moment.");
    } finally {
      setDeleting(false);
    }
  };

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
      keyboardBehavior="interactive"
      android_keyboardInputMode="adjustResize"
      enablePanDownToClose
    >
      <BottomSheetView style={styles.content}>
        <Text style={styles.label}>Title</Text>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Untitled"
          placeholderTextColor={colors.muted}
          maxLength={TITLE_MAX}
          editable={!saving && !deleting}
          returnKeyType="done"
          onSubmitEditing={save}
        />

        {workspaceName ? (
          <View style={styles.workspaceBlock}>
            <Text style={styles.label}>Workspace</Text>
            <Text style={styles.workspaceValue} numberOfLines={1}>
              {workspaceName}
            </Text>
          </View>
        ) : null}

        <View style={styles.actions}>
          <Pressable
            style={[styles.btn, styles.btnSave, !canSave && styles.btnDisabled]}
            onPress={save}
            disabled={!canSave}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.onPrimary} />
            ) : (
              <Text style={styles.btnSaveText}>Save</Text>
            )}
          </Pressable>
        </View>

        <Pressable
          style={styles.deleteRow}
          onPress={confirmDelete}
          disabled={deleting || saving}
        >
          <Ionicons name="trash-outline" size={18} color={colors.down} />
          <Text style={styles.deleteText}>
            {deleting ? "Deleting…" : "Delete this chat"}
          </Text>
        </Pressable>
      </BottomSheetView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  background: { backgroundColor: colors.canvas },
  grabber: { backgroundColor: colors.hairline, width: 36 },
  content: { paddingHorizontal: space.base, paddingTop: space.sm, gap: space.sm },
  label: {
    ...type$.caption,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  input: {
    backgroundColor: colors.surfaceSoft,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    color: colors.ink,
    fontSize: 16,
  },
  actions: { flexDirection: "row", gap: space.xs },
  btn: { flex: 1, paddingVertical: 12, borderRadius: 999, alignItems: "center" },
  btnSave: { backgroundColor: colors.primary },
  btnDisabled: { backgroundColor: colors.primaryDisabled },
  btnSaveText: { ...type$.button, color: colors.onPrimary },
  workspaceBlock: { gap: 4 },
  workspaceValue: { ...type$.bodyMd, color: colors.ink },
  // Centered row — the destructive action sits in the middle of the
  // sheet, mirroring how iOS / iOS-style action sheets center
  // destructive choices.
  deleteRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    marginTop: space.xs,
  },
  deleteText: { ...type$.bodyMd, color: colors.down, fontWeight: "600" },
});
