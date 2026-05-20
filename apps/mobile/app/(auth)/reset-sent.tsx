import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { AuthScaffold } from "../../src/design/AuthScaffold";
import { Icon } from "../../src/design/Icon";
import { colors, type } from "../../src/design/tokens";

const RESEND_SECONDS = 60;

const STEPS = [
  "Open the email and tap the link.",
  "Choose a new password.",
  "You'll be signed in right after.",
];

export default function ResetLinkSentScreen() {
  const params = useLocalSearchParams<{ email?: string }>();
  const email = params.email ?? "your email";
  const [cooldown, setCooldown] = useState(RESEND_SECONDS);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  function resend() {
    if (cooldown > 0) return;
    setCooldown(RESEND_SECONDS);
    // TODO: hook to Better Auth forgetPassword resend
  }

  const mm = Math.floor(cooldown / 60);
  const ss = String(cooldown % 60).padStart(2, "0");

  return (
    <AuthScaffold
      foot={
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={styles.changeText}>
            Wrong address?{" "}
            <Text style={styles.changeLink}>Change email</Text>
          </Text>
        </Pressable>
      }
    >
      <View style={styles.head}>
        <View style={styles.illo}>
          <Icon name="mailOpen" size={28} color={colors.primary} strokeWidth={1.6} />
        </View>
        <Text style={styles.title}>Check your email.</Text>
        <Text style={styles.sub}>
          We sent a reset link to{" "}
          <Text style={styles.subStrong}>{email}</Text>. It expires in 30 minutes.
        </Text>
      </View>

      <View style={styles.checklist}>
        {STEPS.map((s, i) => (
          <View key={i} style={styles.step}>
            <View style={styles.stepNum}>
              <Text style={styles.stepNumText}>{i + 1}</Text>
            </View>
            <Text style={styles.stepText}>{s}</Text>
          </View>
        ))}
      </View>

      <View style={{ flex: 1, minHeight: 12 }} />

      {__DEV__ && (
        <Pressable
          onPress={() => router.push("/(auth)/reset-password")}
          style={styles.devLink}
          hitSlop={8}
        >
          <Text style={styles.devLinkText}>
            DEV · Skip email, open reset form
          </Text>
        </Pressable>
      )}

      <Text style={styles.resend}>
        {cooldown > 0 ? (
          <>
            Didn&apos;t get it?{" "}
            <Text style={styles.resendStrong}>
              Resend in {mm}:{ss}
            </Text>
          </>
        ) : (
          <Text style={styles.resendLink} onPress={resend}>
            Resend
          </Text>
        )}
      </Text>
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  head: { marginTop: 36 },
  illo: {
    width: 64,
    height: 64,
    borderRadius: 18,
    backgroundColor: "rgba(59,123,255,0.10)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 24,
  },
  title: { ...type.authTitle, color: colors.ink },
  sub: { ...type.bodyMd, color: colors.body, marginTop: 8 },
  subStrong: { color: colors.ink, fontWeight: "600" },
  checklist: {
    marginTop: 24,
    padding: 18,
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 14,
    gap: 12,
  },
  step: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  stepNum: {
    width: 22,
    height: 22,
    borderRadius: 999,
    backgroundColor: colors.surfaceStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  stepNumText: { fontSize: 12, fontWeight: "700", color: colors.muted },
  stepText: { flex: 1, ...type.bodySm, color: colors.body },
  resend: {
    ...type.bodySm,
    color: colors.muted,
    textAlign: "center",
    marginBottom: 8,
  },
  resendStrong: { color: colors.body, fontWeight: "500" },
  resendLink: { color: colors.primary, fontWeight: "600" },
  changeText: { ...type.bodySm, color: colors.muted },
  changeLink: { color: colors.primary, fontWeight: "600" },
  devLink: {
    alignSelf: "center",
    marginBottom: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#f59e0b",
    borderStyle: "dashed",
  },
  devLinkText: { fontSize: 12, color: "#b45309" },
});
