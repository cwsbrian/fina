import { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";

type Role = "editor" | "viewer";

export default function InviteMember() {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const trimmed = email.trim();
  const canSubmit =
    !submitting && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setErr(null);
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      await apiFetch(`/workspaces/${wsId}/invites`, {
        method: "POST",
        body: JSON.stringify({ email: trimmed, role }),
      });
      router.back();
    } catch (e) {
      const code = (e as { code?: string }).code ?? "send_failed";
      setErr(
        code === "already_member"
          ? "That email already belongs to a workspace member."
          : code === "duplicate_invite"
            ? "There's already a pending invite for that email."
            : code === "email_send_failed"
              ? "Couldn't send the email. Check the address and try again."
              : `Couldn't invite: ${code}`,
      );
      setSubmitting(false);
    }
  }, [canSubmit, trimmed, role]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <Pressable
          onPress={() => router.back()}
          disabled={submitting}
          hitSlop={8}
        >
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>Invite member</Text>
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
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.body}
        >
          <Text style={styles.sub}>
            Add a family member or roommate. They'll see your transactions and
            budgets — Fina is free for them.
          </Text>

          <Text style={styles.label}>Email</Text>
          <View style={styles.inputWrap}>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={(v) => {
                setEmail(v);
                if (err) setErr(null);
              }}
              placeholder="them@example.com"
              placeholderTextColor={colors.mutedSoft}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              editable={!submitting}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={submit}
            />
            <Ionicons
              name="mail-outline"
              size={16}
              color={colors.muted}
              style={{ marginRight: 12 }}
            />
          </View>

          <Text style={[styles.label, { marginTop: space.lg }]}>Role</Text>
          <View style={styles.roles}>
            <RoleCard
              label="Editor"
              description="Can categorize, edit budgets, add transactions."
              selected={role === "editor"}
              onPress={() => setRole("editor")}
              disabled={submitting}
            />
            <RoleCard
              label="Viewer"
              description="Read-only — sees the numbers, doesn't change them."
              selected={role === "viewer"}
              onPress={() => setRole("viewer")}
              disabled={submitting}
            />
          </View>

          <View style={styles.helper}>
            <Ionicons
              name="mail-outline"
              size={14}
              color={colors.muted}
              style={{ marginTop: 2 }}
            />
            <Text style={styles.helperText}>
              We'll email a magic-link invite. They join automatically after
              signing up — no payment needed.
            </Text>
          </View>

          {err && <Text style={styles.error}>{err}</Text>}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function RoleCard({
  label,
  description,
  selected,
  onPress,
  disabled,
}: {
  label: string;
  description: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.roleCard,
        selected && styles.roleCardSelected,
        pressed && !disabled && { opacity: 0.7 },
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <View style={styles.roleCardHead}>
        <Text
          style={[
            styles.roleCardLabel,
            selected && { color: colors.ink },
          ]}
        >
          {label}
        </Text>
        {selected && (
          <View style={styles.roleCheck}>
            <Ionicons name="checkmark" size={12} color={colors.canvas} />
          </View>
        )}
      </View>
      <Text style={styles.roleCardSub}>{description}</Text>
    </Pressable>
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
  title: { ...type$.titleSm, color: colors.ink, fontWeight: "600" },
  cancel: { ...type$.bodyMd, color: colors.muted },
  save: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },
  body: { padding: space.lg, paddingBottom: space.xl },
  sub: {
    ...type$.bodyMd,
    color: colors.body,
    marginBottom: space.lg,
  },
  label: {
    ...type$.bodySm,
    color: colors.muted,
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: space.xs,
  },
  inputWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surfaceSoft,
    borderRadius: 12,
  },
  input: {
    ...type$.bodyMd,
    color: colors.ink,
    flex: 1,
    paddingHorizontal: space.base,
    paddingVertical: 12,
  },
  roles: { gap: space.sm },
  roleCard: {
    padding: space.base,
    borderRadius: 14,
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1.5,
    borderColor: "transparent",
  },
  roleCardSelected: {
    backgroundColor: colors.canvas,
    borderColor: colors.primary,
  },
  roleCardHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  roleCardLabel: {
    ...type$.bodyMd,
    color: colors.body,
    fontWeight: "600",
  },
  roleCheck: {
    width: 18,
    height: 18,
    borderRadius: 999,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  roleCardSub: { ...type$.bodySm, color: colors.body },

  helper: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginTop: space.lg,
    paddingHorizontal: 4,
  },
  helperText: { ...type$.bodySm, color: colors.muted, flex: 1 },
  error: { ...type$.bodySm, color: colors.down, marginTop: space.base },
});
