import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, space, type as type$ } from "../design/tokens";

export function PaidFeatureLock({
  title,
  body,
  icon = "sparkles-outline",
}: {
  title: string;
  body: string;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View style={styles.body}>
      <View style={styles.iconWrap}>
        <Ionicons name={icon} size={34} color={colors.primary} />
      </View>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.copy}>{body}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="View plans"
        style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]}
        onPress={() => router.push("/plan" as never)}
      >
        <Text style={styles.ctaText}>View plans</Text>
        <Ionicons name="arrow-forward" size={17} color={colors.onPrimary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.xl,
    paddingBottom: space.xxl,
  },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceSoft,
    marginBottom: space.base,
  },
  title: {
    ...type$.titleMd,
    color: colors.ink,
    textAlign: "center",
    marginBottom: 6,
  },
  copy: {
    ...type$.bodyMd,
    color: colors.body,
    textAlign: "center",
    maxWidth: 320,
    marginBottom: space.lg,
  },
  cta: {
    minHeight: 48,
    borderRadius: 999,
    paddingHorizontal: space.xl,
    backgroundColor: colors.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  ctaText: { ...type$.button, color: colors.onPrimary },
});
