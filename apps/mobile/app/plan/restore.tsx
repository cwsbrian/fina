import { useState, useCallback } from "react";
import { View, Text, Pressable, ActivityIndicator, Alert, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, Stack } from "expo-router";
import { finishPurchase, listAvailablePurchases } from "../../src/iap/client";
import { postIAPRestore } from "../../src/api/billing";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";

export default function PlanRestore() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const onRestore = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const purchases = await listAvailablePurchases();
      const first = purchases[0];
      if (!first) {
        setStatus("No previous purchases found.");
        return;
      }
      const platform = first.platform;
      const me = await postIAPRestore({
        platform,
        purchases: purchases.map((p) => ({
          productId: p.productId,
          receipt: p.receipt,
        })),
      });
      await Promise.allSettled(
        purchases
          .filter((p) => p.purchase)
          .map((p) => finishPurchase(p.purchase!)),
      );
      setStatus(`Restored — tier: ${me.tier}`);
      setTimeout(() => router.replace("/(tabs)/" as never), 1200);
    } catch (e: any) {
      Alert.alert("Couldn't restore", e?.message ?? "Try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, router]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <HeaderIconButton icon="chevron-back" onPress={() => router.back()} variant="plain" />
        <Text style={styles.title}>Restore purchases</Text>
        <View style={{ width: 40 }} />
      </View>
      <View
        style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}
      >
        <Pressable
          onPress={onRestore}
          disabled={busy}
          style={{
            padding: 16,
            paddingHorizontal: 28,
            borderRadius: 999,
            backgroundColor: colors.primary,
          }}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={{ color: "#fff", fontWeight: "600" }}>
              Restore purchases
            </Text>
          )}
        </Pressable>
        {status && (
          <Text style={{ marginTop: 16, color: colors.muted }}>{status}</Text>
        )}
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
});
