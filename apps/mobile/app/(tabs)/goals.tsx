import { useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import type { MeDTO as Me } from "@fina/shared";
import { apiFetch } from "../../src/api/client";
import { colors, space, type as type$ } from "../../src/design/tokens";

export default function Goals() {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<Me>("/me")
      .then((m) => !cancelled && setMe(m))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Trial users see "preview" copy; paid Pro users will get the real list
  // when the Goals backend lands. Free / Lite see locked upsell.
  const tier = me?.tier ?? "free";
  const trialActive = me?.trial?.active ?? false;
  const canSeeGoals = tier === "pro" || trialActive;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.head}>
        <Text style={styles.title}>Goals</Text>
      </View>
      <View style={styles.body}>
        <View style={styles.iconWrap}>
          <Ionicons
            name={canSeeGoals ? "flag" : "lock-closed"}
            size={36}
            color={canSeeGoals ? colors.primary : colors.muted}
          />
        </View>
        <Text style={styles.heading}>
          {canSeeGoals ? "Goals are coming soon" : "Goals is a Pro feature"}
        </Text>
        <Text style={styles.body$}>
          {canSeeGoals
            ? "Set a target — Fina will figure out a plan to get you there. Available next release."
            : "Upgrade to Pro to set goals like \"down payment in 3 years\" or \"pay off cards.\""}
        </Text>
        {!canSeeGoals && (
          <Pressable
            style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]}
            onPress={() => router.push("/(tabs)/more" as never)}
          >
            <Text style={styles.ctaText}>Upgrade to Pro</Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  head: { padding: space.lg, paddingBottom: 0 },
  title: { ...type$.titleLg, color: colors.ink },
  body: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.base,
  },
  heading: { ...type$.titleMd, color: colors.ink, marginBottom: 6, textAlign: "center" },
  body$: { ...type$.bodyMd, color: colors.body, textAlign: "center", maxWidth: 320, marginBottom: space.lg },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: space.xl,
    paddingVertical: 14,
    borderRadius: 999,
  },
  ctaText: { ...type$.button, color: colors.onPrimary },
});
