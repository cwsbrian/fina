import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useSession } from "../../src/auth/client";
import { AuthCTA } from "../../src/design/AuthButtons";
import { Icon } from "../../src/design/Icon";
import { colors, type } from "../../src/design/tokens";

const SUCCESS_GREEN = "#1f8c44";
const SUCCESS_BG = "rgba(31,140,68,0.14)";
const SUCCESS_RING = "rgba(31,140,68,0.18)";

export default function ResetDoneScreen() {
  const { data } = useSession();
  const email = data?.user?.email ?? "your account";

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.body}>
        <View style={styles.illoWrap}>
          <View style={styles.illo}>
            <Icon name="check" size={36} color={SUCCESS_GREEN} strokeWidth={2.4} />
          </View>
          <View style={styles.illoRing} />
        </View>

        <Text style={styles.title}>All set</Text>
        <Text style={styles.sub}>
          Password updated. We&apos;ve signed you in on this device.
        </Text>

        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.label}>Account</Text>
            <Text style={styles.value}>{email}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Signed in</Text>
            <Text style={styles.value}>Just now</Text>
          </View>
        </View>

        <View style={styles.tip}>
          <Icon name="check" size={12} color={colors.primary} strokeWidth={1.8} />
          <Text style={styles.tipText}>
            If this wasn&apos;t you, <Text style={styles.tipLink}>sign out everywhere</Text> right away.
          </Text>
        </View>
      </View>

      <View style={styles.footer}>
        <AuthCTA
          label="Continue to Fina"
          onPress={() => router.replace("/(tabs)")}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas, paddingHorizontal: 24 },
  body: { flex: 1, alignItems: "center", paddingTop: 80, gap: 14 },
  illoWrap: {
    width: 88,
    height: 88,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  illo: {
    width: 88,
    height: 88,
    borderRadius: 999,
    backgroundColor: SUCCESS_BG,
    alignItems: "center",
    justifyContent: "center",
  },
  illoRing: {
    position: "absolute",
    top: -10,
    left: -10,
    right: -10,
    bottom: -10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: SUCCESS_RING,
  },
  title: {
    fontSize: 28,
    lineHeight: 31,
    fontWeight: "500",
    letterSpacing: -0.7,
    color: colors.ink,
    marginTop: 6,
  },
  sub: {
    fontSize: 15,
    lineHeight: 22,
    color: colors.muted,
    textAlign: "center",
    maxWidth: 320,
  },
  card: {
    marginTop: 16,
    width: "100%",
    padding: 14,
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 14,
    gap: 8,
  },
  row: { flexDirection: "row", justifyContent: "space-between" },
  label: { fontSize: 13, color: colors.muted },
  value: { fontSize: 13, color: colors.ink, fontWeight: "500" },
  tip: {
    marginTop: 6,
    width: "100%",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: "rgba(217,113,67,0.06)",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  tipText: { flex: 1, fontSize: 12.5, lineHeight: 18, color: colors.body },
  tipLink: { color: colors.primary, fontWeight: "600" },
  footer: { paddingBottom: 24 },
});
