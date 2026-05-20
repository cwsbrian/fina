import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { AuthScaffold } from "../../src/design/AuthScaffold";
import { AuthField } from "../../src/design/AuthField";
import { AuthCTA } from "../../src/design/AuthButtons";
import { authClient } from "../../src/auth/client";
import { colors, type } from "../../src/design/tokens";

export default function ForgotPasswordScreen() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canSubmit = email.includes("@");

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      const result = await authClient.requestPasswordReset({
        email: email.trim(),
        redirectTo: "fina://reset-password",
      });
      if (result.error) {
        throw new Error(result.error.message ?? "Could not send reset link");
      }
      router.push({
        pathname: "/(auth)/reset-sent",
        params: { email: email.trim() },
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not send reset link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScaffold>
      <View style={styles.head}>
        <Text style={styles.title}>Forgot your password?</Text>
        <Text style={styles.sub}>
          Type your email and we&apos;ll send a link to reset it.
        </Text>
      </View>

      <View style={styles.form}>
        <AuthField
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          textContentType="emailAddress"
        />
      </View>

      {err && <Text style={styles.error}>{err}</Text>}

      <AuthCTA
        label="Send reset link"
        onPress={submit}
        busy={busy}
        disabled={!canSubmit}
        style={{ marginTop: 12 }}
      />

      <Text style={styles.foot}>
        Remembered it?{" "}
        <Text
          style={styles.footLink}
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace("/(auth)/sign-in");
          }}
        >
          Back to sign in
        </Text>
      </Text>
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  head: { marginTop: 36 },
  title: { ...type.authTitle, color: colors.ink },
  sub: { ...type.bodyMd, color: colors.body, marginTop: 8 },
  form: { gap: 10, marginTop: 28 },
  error: {
    marginTop: 12,
    ...type.bodySm,
    color: colors.down,
    textAlign: "center",
  },
  foot: {
    ...type.bodySm,
    color: colors.muted,
    marginTop: 24,
    textAlign: "center",
  },
  footLink: { color: colors.primary, fontWeight: "600" },
});
