import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import {
  passwordStrength,
  MIN_PASSWORD_LENGTH,
  meetsPasswordPolicy,
} from "@fina/shared";
import { signUp } from "../../src/auth/client";
import { AuthScaffold } from "../../src/design/AuthScaffold";
import { AuthField } from "../../src/design/AuthField";
import { AuthCTA, SocialButton } from "../../src/design/AuthButtons";
import { colors, type } from "../../src/design/tokens";

function strengthLabel(pw: string): string | undefined {
  const s = passwordStrength(pw);
  if (!s) return undefined;
  return s === "weak" ? "Weak" : s === "okay" ? "Okay" : "Strong";
}

export default function SignUpScreen() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canSubmit =
    name.trim().length > 0 && email.includes("@") && meetsPasswordPolicy(password);

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      const trimmedEmail = email.trim();
      const result = await signUp.email({
        email: trimmedEmail,
        password,
        name: name.trim(),
      });
      if (result.error) {
        if (
          result.error.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" ||
          /already/i.test(result.error.message ?? "")
        ) {
          throw new Error("This email is already registered. Sign in instead?");
        }
        throw new Error(result.error.message ?? "Sign up failed");
      }
      // Backend has emailOTP({ sendVerificationOnSignUp: true }) — a 6-digit
      // code was already sent. Hand off to verify with the email so it can
      // be displayed and used for resend.
      router.replace({
        pathname: "/(auth)/verify",
        params: { email: trimmedEmail },
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Sign up failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScaffold
      centered
      onBack={() => {
        if (router.canGoBack()) router.back();
        else router.replace("/(auth)/sign-in");
      }}
    >
      <View style={styles.head}>
        <Text style={styles.title}>Create your account.</Text>
        <Text style={styles.sub}>
          A trusted home for your money. Set up in 30 seconds.
        </Text>
      </View>

      <View style={styles.form}>
        <AuthField
          label="Full name"
          value={name}
          onChangeText={setName}
          autoCapitalize="words"
          textContentType="name"
        />
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
          strength={strengthLabel(password)}
          textContentType="newPassword"
        />
      </View>

      {err && <Text style={styles.error}>{err}</Text>}

      <AuthCTA
        label="Create account"
        onPress={submit}
        busy={busy}
        disabled={!canSubmit}
        style={{ marginTop: 22 }}
      />

      <View style={styles.divider}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>OR</Text>
        <View style={styles.dividerLine} />
      </View>

      <SocialButton provider="google" label="Continue with Google" />
      <View style={{ height: 10 }} />
      <SocialButton provider="apple" label="Continue with Apple" />

      <Text style={styles.legal}>
        By creating an account you agree to Fina&apos;s{" "}
        <Text style={styles.legalLink}>Terms</Text> and{" "}
        <Text style={styles.legalLink}>Privacy Policy</Text>.
      </Text>
      <Text style={styles.footText}>
          Already have an account?{" "}
          <Text
            style={styles.footLink}
            onPress={() => {
              if (router.canGoBack()) router.back();
              else router.push("/(auth)/sign-in");
            }}
          >
            Sign in
          </Text>
        </Text>
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  head: { marginTop: 0, marginBottom: 0 },
  title: { ...type.authTitle, color: colors.ink, textAlign: "center" },
  sub: { ...type.bodyMd, color: colors.body, marginTop: 8, textAlign: "center" },
  form: { gap: 10, marginTop: 28 },
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
  legal: {
    marginTop: 18,
    ...type.caption,
    color: colors.muted,
    textAlign: "center",
  },
  legalLink: { color: colors.ink, fontWeight: "600" },
  error: {
    marginTop: 12,
    ...type.bodySm,
    color: colors.down,
    textAlign: "center",
  },
  footText: { ...type.bodySm, color: colors.muted, marginTop: 14, textAlign: "center" },
  footLink: { color: colors.primary, fontWeight: "600" },
});
