import { useEffect, useState, useCallback } from "react";
import { View, Text, Pressable, ActivityIndicator, ScrollView, Alert, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, Stack } from "expo-router";
import { fetchProducts, purchaseSubscription, finishPurchase, IapPurchaseError, type LocalProduct } from "../../src/iap/client";
import { postIAPCheckout } from "../../src/api/billing";
import { apiFetch } from "../../src/api/client";
import { type MeDTO as Me } from "@fina/shared";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";

function planDetails(tier: LocalProduct["tier"]): { subtitle: string; bullets: string[] } {
  if (tier === "pro") {
    return {
      subtitle: "For multiple accounts and active planning.",
      bullets: [
        "Up to 10 connected Plaid items",
        "Fina chat, daily brief, and proactive insights",
        "Goals and saving strategy",
      ],
    };
  }
  return {
    subtitle: "For one connected bank and simple tracking.",
    bullets: [
      "1 connected Plaid item",
      "Transactions, categories, and review queue",
      "Budget and spending overview",
    ],
  };
}

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
        const { receipt, platform, purchase } = await purchaseSubscription({
          productId: p.productId,
          userId: me.user.id,
        });
        await postIAPCheckout({ platform, productId: p.productId, receipt });
        // StoreKit 2 requires explicit finish or it re-delivers on next launch.
        // Call only after server returns 2xx so we don't finish a purchase
        // the server failed to record.
        await finishPurchase(purchase);
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

  const body =
    products === null ? (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 80 }}>
        <ActivityIndicator />
      </View>
    ) : (
      <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}>
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
          products.map((p) => {
            const details = planDetails(p.tier);
            return (
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
                  {details.subtitle}
                </Text>
                <View style={{ gap: 8, marginTop: 14 }}>
                  {details.bullets.map((line) => (
                    <View key={line} style={{ flexDirection: "row", gap: 8 }}>
                      <Text style={{ color: colors.primary, fontWeight: "700" }}>•</Text>
                      <Text style={{ flex: 1, color: colors.body }}>{line}</Text>
                    </View>
                  ))}
                </View>
                <Text
                  style={{ marginTop: 14, fontSize: 22, fontWeight: "700", color: colors.ink }}
                >
                  {p.localizedPrice}
                </Text>
                {busy === p.productId && (
                  <ActivityIndicator style={{ marginTop: 8 }} />
                )}
              </Pressable>
            );
          })
        )}
      </ScrollView>
    );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <HeaderIconButton icon="chevron-back" onPress={() => router.back()} variant="plain" />
        <Text style={styles.title}>Choose Plan</Text>
        <View style={{ width: 40 }} />
      </View>
      {body}
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
