import { useEffect, useState, useCallback } from "react";
import { View, Text, Pressable, ActivityIndicator, ScrollView, Alert } from "react-native";
import { useRouter, Stack } from "expo-router";
import { fetchProducts, purchaseSubscription, IapPurchaseError, type LocalProduct } from "../../src/iap/client";
import { postIAPCheckout } from "../../src/api/billing";
import { apiFetch } from "../../src/api/client";
import { type MeDTO as Me } from "@fina/shared";
import { colors } from "../../src/design/tokens";

export default function PlanPicker() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [products, setProducts] = useState<LocalProduct[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<Me>("/me").then(setMe).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    try {
      const list = await fetchProducts();
      setProducts(list);
    } catch {
      setProducts([]); // triggers empty-state
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSubscribe = useCallback(
    async (p: LocalProduct) => {
      if (!me?.user?.id || busy) return;
      setBusy(p.productId);
      try {
        const { receipt, platform } = await purchaseSubscription({
          productId: p.productId,
          userId: me.user.id,
        });
        await postIAPCheckout({ platform, productId: p.productId, receipt });
        router.replace("/(tabs)/" as never);
      } catch (e) {
        if (e instanceof IapPurchaseError) {
          if (e.code === "E_USER_CANCELLED") return;
          if (e.code === "E_ALREADY_OWNED") {
            router.push("/plan/restore" as never);
            return;
          }
          Alert.alert("Couldn't subscribe", e.message);
          return;
        }
        Alert.alert("Couldn't subscribe", "Something went wrong. Try again.");
      } finally {
        setBusy(null);
      }
    },
    [me, busy, router],
  );

  if (products === null) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}>
      <Stack.Screen options={{ title: "Choose a plan" }} />
      {products.length === 0 ? (
        <View
          style={{
            padding: 24,
            borderRadius: 12,
            backgroundColor: colors.surfaceSoft,
          }}
        >
          <Text style={{ fontSize: 16, color: colors.ink }}>
            Subscriptions aren't available right now. Try again later.
          </Text>
          <Pressable onPress={load} style={{ marginTop: 12 }}>
            <Text style={{ color: colors.primary, fontWeight: "600" }}>
              Retry
            </Text>
          </Pressable>
        </View>
      ) : (
        products.map((p) => (
          <Pressable
            key={p.productId}
            onPress={() => onSubscribe(p)}
            disabled={busy !== null}
            style={{
              padding: 20,
              borderRadius: 12,
              backgroundColor: colors.canvas,
              borderWidth: 1,
              borderColor: colors.hairline,
            }}
          >
            <Text
              style={{ fontSize: 18, fontWeight: "700", color: colors.ink }}
            >
              {p.localizedTitle}
            </Text>
            <Text style={{ marginTop: 4, color: colors.muted }}>
              {p.tier === "pro" ? "Unlimited" : "Lite"}
            </Text>
            <Text
              style={{ marginTop: 12, fontSize: 22, fontWeight: "700", color: colors.ink }}
            >
              {p.localizedPrice}
            </Text>
            {busy === p.productId && (
              <ActivityIndicator style={{ marginTop: 8 }} />
            )}
          </Pressable>
        ))
      )}
      {/* Apple Guideline 3.1.1 — Restore must be reachable from plan picker. */}
      <Pressable
        onPress={() => router.push("/plan/restore" as never)}
        style={{ marginTop: 8, alignItems: "center" }}
      >
        <Text style={{ color: colors.primary }}>Restore purchases</Text>
      </Pressable>
    </ScrollView>
  );
}
