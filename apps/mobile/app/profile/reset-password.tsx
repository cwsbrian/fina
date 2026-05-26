import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { passwordStrength, meetsPasswordPolicy, MIN_PASSWORD_LENGTH } from "@fina/shared";
import { authClient } from "../../src/auth/client";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";

export default function ResetPasswordScreen() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showNext, setShowNext] = useState(false);

  const strength = passwordStrength(next);
  const meetsPolicy = meetsPasswordPolicy(next);
  const matches = next.length > 0 && next === confirm;
  const canSubmit =
    current.length > 0 && meetsPolicy && matches && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      const result = await authClient.changePassword({
        currentPassword: current,
        newPassword: next,
      });
      if (result.error) {
        throw new Error(result.error.message ?? "Could not change password");
      }
      router.back();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not change password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <HeaderIconButton icon="chevron-back" variant="plain" onPress={() => router.back()} />
        <Text style={styles.title}>Reset password</Text>
        <Pressable
          onPress={submit}
          disabled={!canSubmit}
          style={({ pressed }) => [
            styles.saveBtn,
            !canSubmit && { opacity: 0.4 },
            pressed && canSubmit && { opacity: 0.7 },
          ]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text style={styles.saveBtnText}>Save</Text>
          )}
        </Pressable>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.eyebrow}>Current password</Text>
          <View style={styles.field}>
            <TextInput
              value={current}
              onChangeText={setCurrent}
              placeholder="••••••••"
              placeholderTextColor={colors.mutedSoft}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              editable={!busy}
              textContentType="password"
            />
          </View>

          <Text style={[styles.eyebrow, { marginTop: space.lg }]}>
            New password
          </Text>
          <View style={styles.field}>
            <TextInput
              value={next}
              onChangeText={setNext}
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              placeholderTextColor={colors.mutedSoft}
              style={[styles.input, { flex: 1 }]}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={!showNext}
              editable={!busy}
              textContentType="newPassword"
            />
            <Pressable
              onPress={() => setShowNext((v) => !v)}
              hitSlop={8}
              style={styles.eyeBtn}
            >
              <Ionicons
                name={showNext ? "eye-off-outline" : "eye-outline"}
                size={18}
                color={colors.muted}
              />
            </Pressable>
          </View>
          {strength && (
            <View style={styles.strengthRow}>
              {(["weak", "fair", "good", "strong"] as const).map((b, i) => {
                const lit =
                  (strength === "weak" && i === 0) ||
                  (strength === "fair" && i <= 1) ||
                  (strength === "good" && i <= 2) ||
                  (strength === "strong" && i <= 3);
                const color = strengthColor(strength);
                return (
                  <View
                    key={b}
                    style={[
                      styles.strengthBar,
                      { backgroundColor: lit ? color : colors.surfaceStrong },
                    ]}
                  />
                );
              })}
              <Text style={[styles.strengthLabel, { color: strengthColor(strength) }]}>
                {strength}
              </Text>
            </View>
          )}

          <Text style={[styles.eyebrow, { marginTop: space.lg }]}>
            Confirm new password
          </Text>
          <View style={styles.field}>
            <TextInput
              value={confirm}
              onChangeText={setConfirm}
              placeholder="Repeat new password"
              placeholderTextColor={colors.mutedSoft}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={!showNext}
              editable={!busy}
              textContentType="newPassword"
              returnKeyType="done"
              onSubmitEditing={submit}
            />
          </View>
          {confirm.length > 0 && !matches && (
            <Text style={styles.helperError}>Passwords don&apos;t match</Text>
          )}

          {err && <Text style={styles.errText}>{err}</Text>}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function strengthColor(s: "weak" | "fair" | "good" | "strong"): string {
  switch (s) {
    case "weak": return colors.down;
    case "fair": return colors.accentYellow;
    case "good": return colors.softBlue;
    case "strong": return colors.up;
  }
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  head: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.base,
    paddingVertical: space.sm,
    gap: space.sm,
  },
  title: { ...type$.titleMd, color: colors.ink, flex: 1 },
  saveBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    minWidth: 56,
    alignItems: "center",
    justifyContent: "center",
  },
  saveBtnText: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },
  scroll: { padding: space.lg, paddingBottom: space.xxl },
  eyebrow: {
    ...type$.captionStrong,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: space.xs,
  },
  field: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surfaceSoft,
    borderRadius: 12,
    paddingHorizontal: space.base,
    paddingVertical: 12,
  },
  input: { ...type$.bodyMd, color: colors.ink, padding: 0, flex: 1 },
  eyeBtn: { paddingLeft: space.sm },
  strengthRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: space.xs,
    paddingHorizontal: 4,
  },
  strengthBar: {
    flex: 1,
    height: 4,
    borderRadius: 2,
  },
  strengthLabel: {
    ...type$.bodySm,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    marginLeft: 8,
  },
  helperError: {
    ...type$.bodySm,
    color: colors.down,
    marginTop: space.xs,
    paddingHorizontal: 4,
  },
  errText: {
    ...type$.bodyMd,
    color: colors.down,
    textAlign: "center",
    marginTop: space.lg,
  },
});
