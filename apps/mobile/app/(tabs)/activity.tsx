import { View, Text, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { colors, space, type as type$ } from "../../src/design/tokens";

export default function Activity() {
  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.head}>
        <Text style={styles.title}>Activity</Text>
      </View>
      <View style={styles.empty}>
        <View style={styles.iconWrap}>
          <Ionicons name="receipt-outline" size={36} color={colors.muted} />
        </View>
        <Text style={styles.emptyTitle}>No transactions yet</Text>
        <Text style={styles.emptyBody}>
          Connect a bank to import automatically, or add transactions manually.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  head: { padding: space.lg, paddingBottom: 0 },
  title: { ...type$.titleLg, color: colors.ink },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.base,
  },
  emptyTitle: { ...type$.titleMd, color: colors.ink, marginBottom: 6, textAlign: "center" },
  emptyBody: { ...type$.bodyMd, color: colors.body, textAlign: "center", maxWidth: 280 },
});
