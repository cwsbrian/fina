import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { AuthScaffold } from "../../src/design/AuthScaffold";
import { AuthField } from "../../src/design/AuthField";
import { AuthCTA } from "../../src/design/AuthButtons";
import { Icon } from "../../src/design/Icon";
import { authClient } from "../../src/auth/client";
import { colors, type } from "../../src/design/tokens";

function strengthOf(pw: string): string | undefined {
  if (pw.length === 0) return undefined;
  if (pw.length < 8) return "Weak";
  if (pw.length < 12) return "Okay";
  return "Strong";
}

function hasLetterAndNumber(pw: string) {
  return /[a-zA-Z]/.test(pw) && /[0-9!@#$%^&*()_+\-=\[\]{};:'",.<>/?\\|`~]/.test(pw);
}

type RuleProps = { met: boolean; label: string };

function Rule({ met, label }: RuleProps) {
  return (
    <View style={[ruleStyles.row]}>
      <View style={[ruleStyles.ic, met && ruleStyles.icMet]}>
        <Icon
          name="check"
          size={11}
          color={met ? "#1f8c44" : colors.mutedSoft}
          strokeWidth={2.6}
        />
      </View>
      <Text style={[ruleStyles.label, met && ruleStyles.labelMet]}>
        {label}
      </Text>
    </View>
  );
}

export default function ResetPasswordScreen() {
  const params = useLocalSearchParams<{ token?: string }>();
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ruleLen = pw.length >= 8;
  const ruleMix = hasLetterAndNumber(pw);
  const ruleMatch = pw.length > 0 && pw === confirm;
  const canSubmit = ruleLen && ruleMix && ruleMatch;

  async function submit() {
    if (!canSubmit) return;
    if (!params.token) {
      setErr("Missing reset token. Open the link from your email again.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const result = await authClient.resetPassword({
        newPassword: pw,
        token: params.token,
      });
      if (result.error) {
        throw new Error(result.error.message ?? "Could not update password");
      }
      router.replace("/(auth)/reset-done");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not update password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScaffold>
      <View style={styles.head}>
        <Text style={styles.title}>Pick a new password.</Text>
        <Text style={styles.sub}>
          Make it something you&apos;ll remember, at least 8 characters.
        </Text>
      </View>

      <View style={styles.form}>
        <AuthField
          label="New password"
          value={pw}
          onChangeText={setPw}
          secret
          strength={strengthOf(pw)}
          textContentType="newPassword"
        />
        <AuthField
          label="Confirm new password"
          value={confirm}
          onChangeText={setConfirm}
          secret
          textContentType="newPassword"
        />
      </View>

      <View style={styles.rules}>
        <Rule met={ruleLen} label="At least 8 characters" />
        <Rule met={ruleMix} label="Mix of letters and numbers or symbols" />
        <Rule met={ruleMatch} label="Passwords match" />
      </View>

      {err && <Text style={styles.error}>{err}</Text>}

      <AuthCTA
        label="Set new password"
        onPress={submit}
        busy={busy}
        disabled={!canSubmit}
        style={{ marginTop: 12 }}
      />

      <Text style={styles.foot}>
        Changed your mind?{" "}
        <Text
          style={styles.footLink}
          onPress={() => router.replace("/(auth)/sign-in")}
        >
          Cancel
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
  rules: { marginTop: 14, gap: 6, paddingHorizontal: 4 },
  error: {
    marginTop: 12,
    ...type.bodySm,
    color: colors.down,
    textAlign: "center",
  },
  foot: {
    ...type.bodySm,
    color: colors.muted,
    textAlign: "center",
    marginTop: 14,
  },
  footLink: { color: colors.primary, fontWeight: "600" },
});

const ruleStyles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  ic: {
    width: 18,
    height: 18,
    borderRadius: 999,
    backgroundColor: colors.surfaceStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  icMet: { backgroundColor: "rgba(31,140,68,0.16)" },
  label: { fontSize: 12.5, color: colors.muted },
  labelMet: { color: colors.body },
});
