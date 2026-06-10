import { useCallback, useEffect, useState } from "react";
import { View, Text, Pressable, ActivityIndicator, StyleSheet, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, useRouter } from "expo-router";
import { tierLabel, type MeDTO as Me } from "@fina/shared";
import { apiFetch } from "../../src/api/client";
import { openManageBilling } from "../../src/iap/manage";
import { syncNativeSubscriptionManagement } from "../../src/iap/sync";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
import { colors, space, type as type$ } from "../../src/design/tokens";

export default function PlanNativeManagement() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [opening, setOpening] = useState(false);
  const [openedOnce, setOpenedOnce] = useState(false);

  useEffect(() => {
    apiFetch<Me>("/me")
      .then(setMe)
      .catch(() => {});
  }, []);

  const openNativeManagement = useCallback(async () => {
    if (opening) return;
    setOpening(true);
    try {
      if (Platform.OS === "ios") {
        const nextMe = await syncNativeSubscriptionManagement();
        setMe(nextMe);
        if (nextMe.subscription) router.replace("/plan/details" as never);
      } else {
        await openManageBilling(me?.subscription?.tier);
        const nextMe = await apiFetch<Me>("/me");
        setMe(nextMe);
      }
    } catch (e) {
      console.warn("[billing.native] closed or failed", e);
      apiFetch<Me>("/me")
        .then(setMe)
        .catch(() => {});
    } finally {
      setOpenedOnce(true);
      setOpening(false);
    }
  }, [me?.subscription?.tier, opening, router]);

  useEffect(() => {
    if (me && !openedOnce && !opening) {
      void openNativeManagement();
    }
  }, [me, openedOnce, opening, openNativeManagement]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <HeaderIconButton icon="chevron-back" onPress={() => router.back()} variant="plain" />
        <Text style={styles.title}>Plan</Text>
        <View style={{ width: 40 }} />
      </View>
      <View style={styles.center}>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Current plan</Text>
          <Text style={styles.planName}>
            {me ? tierLabel(me.tier, me.trial.active) : "Loading"}
          </Text>
        </View>
        <Pressable style={styles.btnPrimary} onPress={openNativeManagement} disabled={opening}>
          {opening ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.btnPrimaryText}>
              {Platform.OS === "ios" ? "Open App Store subscriptions" : "Open billing"}
            </Text>
          )}
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  title: { ...type$.titleSm, color: colors.ink, fontWeight: "600" },
  center: {
    flex: 1,
    justifyContent: "center",
    padding: space.lg,
    gap: space.base,
  },
  card: {
    backgroundColor: colors.surfaceSoft,
    borderRadius: 14,
    padding: space.lg,
    gap: 4,
  },
  cardLabel: {
    ...type$.bodySm,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  planName: { ...type$.titleSm, color: colors.ink, fontWeight: "700" },
  btnPrimary: {
    backgroundColor: colors.primary,
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: "center",
  },
  btnPrimaryText: { ...type$.bodyMd, color: "#fff", fontWeight: "600" },
});
