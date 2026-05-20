import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { signIn } from "../../src/auth/client";
import { AuthScaffold } from "../../src/design/AuthScaffold";
import { AuthField } from "../../src/design/AuthField";
import { AuthCTA, SocialButton } from "../../src/design/AuthButtons";
import { colors, type } from "../../src/design/tokens";

export default function SignInScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canSubmit = email.includes("@") && password.length >= 8;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      const result = await signIn.email({ email: email.trim(), password });
      if (result.error) {
        throw new Error(result.error.message ?? "Sign in failed");
      }
      router.replace("/(tabs)");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScaffold centered hideBack>
      <View style={styles.head}>
        <Text style={styles.title}>Welcome back.</Text>
        <Text style={styles.sub}>Pick up right where you left off.</Text>
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
        <AuthField
          label="Password"
          value={password}
          onChangeText={setPassword}
          secret
          textContentType="password"
        />
      </View>

      <View style={styles.helperRow}>
        <Pressable hitSlop={8}>
          <Text style={styles.helperLink}>Forgot password?</Text>
        </Pressable>
      </View>

      {err && <Text style={styles.error}>{err}</Text>}

      <AuthCTA
        label="Sign in"
        onPress={submit}
        busy={busy}
        disabled={!canSubmit}
        style={{ marginTop: 12 }}
      />

      <View style={styles.divider}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>OR</Text>
        <View style={styles.dividerLine} />
      </View>

      <SocialButton provider="google" label="Continue with Google" />
      <View style={{ height: 10 }} />
      <SocialButton provider="apple" label="Continue with Apple" />
      <View style={{ height: 10 }} />
      <SocialButton provider="magic" label="Email me a magic link" />
      <Text style={styles.footText}>
          New to Fina?{" "}
          <Text
            style={styles.footLink}
            onPress={() => router.replace("/(auth)/sign-up")}
          >
            Create an account
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
  helperRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 10,
  },
  helperLink: {
    ...type.bodySm,
    color: colors.ink,
    fontWeight: "600",
    padding: 4,
  },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginVertical: 18,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.hairline },
  dividerText: {
    ...type.caption,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  error: {
    marginTop: 12,
    ...type.bodySm,
    color: colors.down,
    textAlign: "center",
  },
  footText: { ...type.bodySm, color: colors.muted, marginTop: 14, textAlign: "center" },
  footLink: { color: colors.primary, fontWeight: "600" },
});
