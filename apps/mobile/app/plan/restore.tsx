import { useState, useCallback } from "react";
import { View, Text, Pressable, ActivityIndicator, Alert } from "react-native";
import { useRouter, Stack } from "expo-router";
import { listAvailablePurchases } from "../../src/iap/client";
import { postIAPRestore } from "../../src/api/billing";
import { colors } from "../../src/design/tokens";

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
      if (purchases.length === 0) {
        setStatus("No previous purchases found.");
        return;
      }
      const platform = purchases[0].platform;
      const me = await postIAPRestore({
        platform,
        purchases: purchases.map((p) => ({
          productId: p.productId,
          receipt: p.receipt,
        })),
      });
      setStatus(`Restored — tier: ${me.tier}`);
      setTimeout(() => router.replace("/(tabs)/" as never), 1200);
    } catch (e: any) {
      Alert.alert("Couldn't restore", e?.message ?? "Try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, router]);

  return (
    <View
      style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}
    >
      <Stack.Screen options={{ title: "Restore purchases" }} />
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
  );
}
