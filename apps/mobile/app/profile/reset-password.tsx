import { useEffect, useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { MeDTO } from "@fina/shared";
import { apiFetch } from "../../src/api/client";
import { authClient } from "../../src/auth/client";
import { env } from "../../src/env";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";

export default function ResetPasswordScreen() {
  const [email, setEmail] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<MeDTO>("/me")
      .then((m) => setEmail(m.user.email))
      .catch((e) => setLoadErr((e as { code?: string }).code ?? "load_error"));
  }, []);

  async function send() {
    if (!email || busy) return;
    setBusy(true);
    setSendErr(null);
    try {
      const result = await authClient.requestPasswordReset({
        email,
        redirectTo: `${env.EXPO_PUBLIC_WEB_URL}/reset-password`,
      });
      if (result.error) {
        throw new Error(result.error.message ?? "Could not send reset link");
      }
      setSent(true);
    } catch (e) {
      setSendErr(e instanceof Error ? e.message : "Could not send reset link");
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
      </View>

      <View style={styles.body}>
        {!email && !loadErr && <ActivityIndicator color={colors.primary} />}
        {loadErr && <Text style={styles.errText}>Couldn't load ({loadErr})</Text>}

        {email && !sent && (
          <>
            <Ionicons name="lock-closed-outline" size={48} color={colors.primary} style={{ marginBottom: space.base }} />
            <Text style={styles.heading}>Send a reset link?</Text>
            <Text style={styles.sub}>
              We&apos;ll email a link to{" "}
              <Text style={styles.emailEmphasis}>{email}</Text>. Tap it from any
              device to set a new password.
            </Text>
            {sendErr && <Text style={styles.errText}>{sendErr}</Text>}
            <Pressable
              style={({ pressed }) => [
                styles.btnPrimary,
                pressed && { opacity: 0.7 },
                busy && { opacity: 0.6 },
              ]}
              onPress={send}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <Text style={styles.btnPrimaryText}>Send reset link</Text>
              )}
            </Pressable>
          </>
        )}

        {sent && (
          <>
            <Ionicons name="mail-outline" size={48} color={colors.primary} style={{ marginBottom: space.base }} />
            <Text style={styles.heading}>Check your inbox</Text>
            <Text style={styles.sub}>
              A reset link is on its way to{" "}
              <Text style={styles.emailEmphasis}>{email}</Text>. The link is
              good for one hour.
            </Text>
            <Pressable
              style={({ pressed }) => [styles.btnGhost, pressed && { opacity: 0.7 }]}
              onPress={() => router.back()}
            >
              <Text style={styles.btnGhostText}>Done</Text>
            </Pressable>
          </>
        )}
      </View>
    </SafeAreaView>
  );
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
  title: { ...type$.titleMd, color: colors.ink },
  body: {
    flex: 1,
    padding: space.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  heading: {
    ...type$.titleMd,
    color: colors.ink,
    textAlign: "center",
    marginBottom: space.sm,
  },
  sub: {
    ...type$.bodyMd,
    color: colors.body,
    textAlign: "center",
    marginBottom: space.lg,
    maxWidth: 320,
  },
  emailEmphasis: { fontWeight: "600", color: colors.ink },
  errText: {
    ...type$.bodySm,
    color: colors.down,
    textAlign: "center",
    marginBottom: space.base,
  },
  btnPrimary: {
    backgroundColor: colors.primary,
    paddingHorizontal: space.xl,
    paddingVertical: 14,
    borderRadius: 999,
    minWidth: 220,
    alignItems: "center",
    justifyContent: "center",
  },
  btnPrimaryText: { ...type$.bodyMd, color: colors.onPrimary, fontWeight: "600" },
  btnGhost: {
    paddingHorizontal: space.xl,
    paddingVertical: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.hairline,
    minWidth: 220,
    alignItems: "center",
    justifyContent: "center",
  },
  btnGhostText: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
});
