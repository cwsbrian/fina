import { useEffect, useState, useCallback } from "react";
import { View, Text, Pressable, ActivityIndicator, ScrollView, Alert, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, Stack } from "expo-router";
import {
  fetchProducts,
  purchaseSubscription,
  finishPurchase,
  listAvailablePurchases,
  IapPurchaseError,
  type LocalProduct,
} from "../../src/iap/client";
import { postIAPCheckout, postIAPRestore } from "../../src/api/billing";
import { apiFetch } from "../../src/api/client";
import { tierLabel, type MeDTO as Me } from "@fina/shared";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";

function planDetails(tier: LocalProduct["tier"]): { subtitle: string; bullets: string[] } {
  if (tier === "pro") {
    return {
      subtitle: "For everyday planning with full Fina access.",
      bullets: [
        "Up to 5 connected bank accounts",
        "Fina chat, daily brief, and proactive insights",
        "Goals and saving strategy",
      ],
    };
  }
  return {
    subtitle: "For heavier use and more connected accounts.",
    bullets: [
      "Up to 20 connected bank accounts",
      "More room for AI chat",
      "Everything included in Pro",
    ],
  };
}

function planPrice(tier: LocalProduct["tier"]): string {
  return tier === "pro" ? "$7.99 / month" : "$16.99 / month";
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null) {
    const x = e as { code?: unknown; status?: unknown; message?: unknown };
    if (typeof x.message === "string") return x.message;
    if (typeof x.code === "string") {
      return typeof x.status === "number" ? `${x.code} (HTTP ${x.status})` : x.code;
    }
  }
  return "Something went wrong. Try again.";
}

function hasSubscription(me: Me): boolean {
  return Boolean(me.subscription);
}

async function restoreOwnedPurchases(): Promise<Me> {
  const purchases = await listAvailablePurchases();
  if (purchases.length === 0) {
    throw new Error("No previous purchases found.");
  }
  const nextMe = await postIAPRestore({
    platform: purchases[0]!.platform,
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
  return nextMe;
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
      if (!me?.user?.id || busy || me.subscription?.tier === p.tier) return;
      setBusy(p.productId);
      try {
        const { receipt, platform, purchase } = await purchaseSubscription({
          productId: p.productId,
          userId: me.user.id,
        });
        const nextMe = await postIAPCheckout({ platform, productId: p.productId, receipt });
        // StoreKit 2 requires explicit finish or it re-delivers on next launch.
        // Call only after server returns 2xx so we don't finish a purchase
        // the server failed to record.
        await finishPurchase(purchase);
        setMe(nextMe);
        router.replace("/plan/details" as never);
      } catch (e) {
        if (e instanceof IapPurchaseError) {
          if (e.code === "E_USER_CANCELLED") return;
          if (e.code === "E_ALREADY_OWNED") {
            try {
              const nextMe = await restoreOwnedPurchases();
              setMe(nextMe);
              Alert.alert("Subscription restored", `You're on ${tierLabel(nextMe.tier, nextMe.trial.active)}.`);
              router.replace("/plan/details" as never);
            } catch (restoreErr) {
              try {
                const latestMe = await apiFetch<Me>("/me");
                setMe(latestMe);
                if (hasSubscription(latestMe)) {
                  router.replace("/plan/details" as never);
                  return;
                }
              } catch {
                // Fall through to the actionable App Store state message.
              }
              const detail = errorMessage(restoreErr);
              Alert.alert(
                "Already subscribed",
                detail === "No previous purchases found."
                  ? "App Store says this Apple ID already has a subscription, but it did not return an active receipt to restore. Try Restore purchases, or check the sandbox subscription state in Settings."
                  : detail,
              );
              router.push("/plan/restore" as never);
            }
            return;
          }
          Alert.alert("Couldn't subscribe", e.message);
          return;
        }
        Alert.alert("Couldn't subscribe", errorMessage(e));
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
            const recommended = p.tier === "pro";
            const currentTier =
              me?.subscription?.tier ??
              (!me?.trial.active && (me?.tier === "pro" || me?.tier === "max")
                ? me.tier
                : null);
            const isCurrent = currentTier === p.tier;
            return (
              <Pressable
                key={p.productId}
                onPress={() => onSubscribe(p)}
                disabled={busy !== null || isCurrent}
                style={{
                  padding: 20,
                  borderRadius: 12,
                  backgroundColor: colors.canvas,
                  borderWidth: recommended ? 2 : 1,
                  borderColor: recommended ? colors.primary : colors.hairline,
                }}
              >
                {recommended && (
                  <View style={styles.recommendedBadge}>
                    <Text style={styles.recommendedText}>Recommended</Text>
                  </View>
                )}
                {isCurrent && (
                  <View style={styles.currentBadge}>
                    <Text style={styles.currentText}>Current plan</Text>
                  </View>
                )}
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
                  {planPrice(p.tier)}
                </Text>
                <Text style={{ marginTop: 12, color: colors.primary, fontWeight: "700" }}>
                  {isCurrent ? "Current plan" : "Subscribe"}
                </Text>
                {isCurrent && (
                  <Text style={{ marginTop: 4, color: colors.muted }}>
                    This is your active subscription.
                  </Text>
                )}
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
  recommendedBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "rgba(62, 179, 139, 0.12)",
    marginBottom: 10,
  },
  recommendedText: {
    ...type$.caption,
    color: colors.primary,
    fontWeight: "700",
  },
  currentBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    marginBottom: 10,
  },
  currentText: {
    ...type$.caption,
    color: colors.ink,
    fontWeight: "700",
  },
});
