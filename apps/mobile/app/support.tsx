import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { File } from "expo-file-system";
import { apiFetch } from "../src/api/client";
import { colors, space, type as type$ } from "../src/design/tokens";

const MAX_FILES = 3;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

type Attachment = {
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
};

export default function Support() {
  const subjectRef = useRef<TextInput>(null);
  const messageRef = useRef<TextInput>(null);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const trimmedSubject = subject.trim();
  const trimmedMessage = message.trim();
  const canSubmit =
    !submitting && trimmedSubject.length > 0 && trimmedMessage.length > 0;

  const dismissInputs = useCallback(() => {
    subjectRef.current?.blur();
    messageRef.current?.blur();
    Keyboard.dismiss();
  }, []);

  const dismissInputsAfterPicker = useCallback(() => {
    requestAnimationFrame(() => {
      dismissInputs();
      setTimeout(dismissInputs, 80);
    });
  }, [dismissInputs]);

  const addAttachments = useCallback((picked: Attachment[], totalPicked: number) => {
    const remaining = MAX_FILES - attachments.length;
    const next = picked
      .filter((a) => !a.size || a.size <= MAX_FILE_BYTES)
      .slice(0, remaining);
    if (next.length < totalPicked) {
      Alert.alert("Some files skipped", "Files must be 5 MB or smaller.");
    }
    setAttachments((prev) => [...prev, ...next]);
  }, [attachments.length]);

  const addFiles = useCallback(async () => {
    dismissInputs();
    const remaining = MAX_FILES - attachments.length;
    if (remaining <= 0) {
      Alert.alert("Attachment limit", `You can attach up to ${MAX_FILES} files.`);
      return;
    }
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (picked.canceled) return;
      addAttachments(
        picked.assets.map((a) => ({
          uri: a.uri,
          name: a.name,
          ...(a.mimeType ? { mimeType: a.mimeType } : {}),
          ...(a.size ? { size: a.size } : {}),
        })),
        picked.assets.length,
      );
    } finally {
      dismissInputsAfterPicker();
    }
  }, [addAttachments, attachments.length, dismissInputs, dismissInputsAfterPicker]);

  const addPhotos = useCallback(async () => {
    dismissInputs();
    const remaining = MAX_FILES - attachments.length;
    if (remaining <= 0) {
      Alert.alert("Attachment limit", `You can attach up to ${MAX_FILES} files.`);
      return;
    }
    try {
      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        selectionLimit: remaining,
        quality: 1,
      });
      if (picked.canceled) return;
      addAttachments(
        picked.assets.map((a, i) => ({
          uri: a.uri,
          name: a.fileName ?? `photo-${Date.now()}-${i + 1}.jpg`,
          ...(a.mimeType ? { mimeType: a.mimeType } : { mimeType: "image/jpeg" }),
          ...(a.fileSize ? { size: a.fileSize } : {}),
        })),
        picked.assets.length,
      );
    } finally {
      dismissInputsAfterPicker();
    }
  }, [addAttachments, attachments.length, dismissInputs, dismissInputsAfterPicker]);

  const chooseAttachment = useCallback(() => {
    dismissInputs();
    Alert.alert("Attach file", "Choose an attachment source.", [
      { text: "Photo library", onPress: addPhotos },
      { text: "Files", onPress: addFiles },
      { text: "Cancel", style: "cancel" },
    ]);
  }, [addFiles, addPhotos, dismissInputs]);

  const removeFile = useCallback((uri: string) => {
    setAttachments((prev) => prev.filter((a) => a.uri !== uri));
  }, []);

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setErr(null);
    try {
      const files = await Promise.all(
        attachments.map(async (a) => ({
          filename: a.name,
          contentType: a.mimeType,
          contentBase64: await new File(a.uri).base64(),
        })),
      );
      await apiFetch("/support/tickets", {
        method: "POST",
        body: JSON.stringify({
          subject: trimmedSubject,
          message: trimmedMessage,
          attachments: files,
        }),
      });
      Alert.alert("Sent", "We'll reply by email.", [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "send_failed");
      setSubmitting(false);
    }
  }, [attachments, canSubmit, trimmedMessage, trimmedSubject]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <Pressable onPress={() => router.back()} disabled={submitting} hitSlop={8}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>Contact support</Text>
        <Pressable onPress={submit} disabled={!canSubmit} hitSlop={8}>
          {submitting ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text style={[styles.save, !canSubmit && { opacity: 0.5 }]}>
              Send
            </Text>
          )}
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.label}>Subject</Text>
          <TextInput
            ref={subjectRef}
            value={subject}
            onChangeText={setSubject}
            placeholder="What happened?"
            placeholderTextColor={colors.mutedSoft}
            style={styles.input}
            editable={!submitting}
            maxLength={120}
            returnKeyType="next"
          />

          <Text style={styles.label}>Message</Text>
          <TextInput
            ref={messageRef}
            value={message}
            onChangeText={setMessage}
            placeholder="Tell us what you need help with."
            placeholderTextColor={colors.mutedSoft}
            style={[styles.input, styles.message]}
            editable={!submitting}
            multiline
            textAlignVertical="top"
            maxLength={5000}
          />

          <Pressable
            onPress={chooseAttachment}
            disabled={submitting || attachments.length >= MAX_FILES}
            style={({ pressed }) => [
              styles.attachBtn,
              (pressed || attachments.length >= MAX_FILES) && { opacity: 0.6 },
            ]}
          >
            <Ionicons name="attach-outline" size={18} color={colors.primary} />
            <Text style={styles.attachText}>Attach file</Text>
          </Pressable>

          {attachments.map((a) => (
            <View key={a.uri} style={styles.fileRow}>
              <Ionicons name="document-outline" size={18} color={colors.muted} />
              <Text style={styles.fileName} numberOfLines={1}>
                {a.name}
              </Text>
              <Pressable onPress={() => removeFile(a.uri)} disabled={submitting}>
                <Ionicons name="close" size={18} color={colors.muted} />
              </Pressable>
            </View>
          ))}

          {err && <Text style={styles.error}>Couldn't send: {err}</Text>}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.base,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  cancel: { ...type$.bodyMd, color: colors.muted },
  save: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },
  title: { ...type$.titleSm, color: colors.ink, fontWeight: "600" },
  body: { padding: space.lg, paddingBottom: space.xl },
  label: {
    ...type$.bodySm,
    color: colors.muted,
    fontWeight: "600",
    marginBottom: space.xs,
  },
  input: {
    ...type$.bodyMd,
    color: colors.ink,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 12,
    paddingHorizontal: space.base,
    paddingVertical: 12,
    marginBottom: space.lg,
  },
  message: { minHeight: 140 },
  attachBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    marginBottom: space.base,
  },
  attachText: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  fileName: { ...type$.bodySm, color: colors.ink, flex: 1 },
  error: { ...type$.bodySm, color: colors.down, marginTop: space.base },
});
