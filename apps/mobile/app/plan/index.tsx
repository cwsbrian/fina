import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  View,
  Text,
  Pressable,
  ActivityIndicator,
  StyleSheet,
  Platform,
  Alert,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  PRICING,
  TIER_LIMITS,
  formatShortDate,
  subscriptionSourceLabel,
  tierLabel,
  trialDaysLeft,
  trialRevertsTo,
  type MeDTO as Me,
  type PaidTier,
} from "@fina/shared";
import { apiFetch } from "../../src/api/client";
import { IapPurchaseError } from "../../src/iap/client";
import { nativeBillingUnavailableMessage, openManageBilling } from "../../src/iap/manage";
import {
  checkoutNativeSubscription,
  fetchMeWithNativeSubscriptionSync,
  restoreCurrentNativeSubscriptions,
  syncCurrentNativeSubscriptions,
} from "../../src/iap/sync";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
import { colors, space, type as type$ } from "../../src/design/tokens";
import type { SubscriptionSource } from "@fina/shared";

type BusyState = PaidTier | "manage" | "restore" | null;

const PLAN_COPY: Record<
  PaidTier,
  {
    badge?: string;
    title: string;
    summary: string;
    features: string[];
  }
> = {
  pro: {
    badge: "Recommended",
    title: "Pro",
    summary: "Automatic tracking and the full Fina chat experience.",
    features: [
      `Up to ${TIER_LIMITS.pro.plaidItems} connected banks`,
      "Full Fina chat",
      "Spending recap cards",
      "Budget tracking",
      "Upcoming recurring spend",
      "Standard AI usage",
    ],
  },
  max: {
    title: "Max",
    summary: "More connections and expanded AI usage for heavier workflows.",
    features: [
      `Up to ${TIER_LIMITS.max.plaidItems} connected banks`,
      "Expanded AI usage",
      "Full Fina chat",
      "Spending recap cards",
      "Budget tracking",
      "Upcoming recurring spend",
    ],
  },
};

export default function PlanScreen() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState<BusyState>(null);
  const busyRef = useRef<BusyState>(null);
  const nativeSource: SubscriptionSource =
    Platform.OS === "ios" ? "iap_apple" : "iap_google";
  const storeName = Platform.OS === "ios" ? "the App Store" : "Google Play";

  const goHome = useCallback(() => {
    router.replace("/(tabs)" as never);
  }, [router]);

  const goBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    goHome();
  }, [goHome, router]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const loadMe = useCallback(async (): Promise<Me | null> => {
    const fetchMe =
      Platform.OS === "ios" || Platform.OS === "android"
        ? fetchMeWithNativeSubscriptionSync
        : () => apiFetch<Me>("/me");
    try {
      const nextMe = await fetchMe();
      setMe(nextMe);
      return nextMe;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  const refreshNativeState = useCallback(async (): Promise<Me | null> => {
    if (Platform.OS === "ios" || Platform.OS === "android") {
      const synced = await syncCurrentNativeSubscriptions().catch(() => null);
      if (synced) {
        setMe(synced);
        return synced;
      }
    }
    return await loadMe();
  }, [loadMe]);

  useEffect(() => {
    if (Platform.OS !== "ios" && Platform.OS !== "android") return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active" || !busyRef.current) return;
      void refreshNativeState().finally(() => setBusy(null));
    });
    return () => sub.remove();
  }, [refreshNativeState]);

  useEffect(() => {
    if ((Platform.OS !== "ios" && Platform.OS !== "android") || !busy) return;
    const timeout = setTimeout(() => {
      void refreshNativeState().finally(() => setBusy(null));
    }, 90_000);
    return () => clearTimeout(timeout);
  }, [busy, refreshNativeState]);

  const openNativeManagement = useCallback(async () => {
    if (busy) return;
    if (!me?.subscription && Platform.OS === "android") return;
    const unavailable = nativeBillingUnavailableMessage(me?.subscription?.source);
    if (unavailable) {
      Alert.alert("Manage subscription", unavailable);
      return;
    }
    setBusy("manage");
    try {
      await openManageBilling(me?.subscription?.tier, me?.subscription?.source);
      void loadMe();
    } catch (e: any) {
      Alert.alert("Couldn't open store billing", e?.message ?? "Try again.");
    } finally {
      setBusy(null);
    }
  }, [busy, loadMe, me?.subscription]);

  const restoreNativeSubscription = useCallback(async () => {
    if (busy) return;
    setBusy("restore");
    try {
      const nextMe = await restoreCurrentNativeSubscriptions();
      if (!nextMe) {
        Alert.alert(
          "No subscription found",
          `No active Fina subscription was found in ${storeName}.`,
        );
        await loadMe();
        return;
      }
      setMe(nextMe);
      if (nextMe.iapIntegrity.isPlanMismatch) {
        Alert.alert(
          "Restore incomplete",
          "We found a subscription, but it still does not match this Fina account.",
        );
        return;
      }
      goHome();
    } catch (e: any) {
      Alert.alert("Restore failed", e?.message ?? "Try again.");
      void loadMe();
    } finally {
      setBusy(null);
    }
  }, [busy, goHome, loadMe, storeName]);

  const startNativeCheckout = useCallback(
    async (tier: PaidTier) => {
      if (busy || !me?.user.id) return;
      const unavailable = nativeBillingUnavailableMessage(me?.subscription?.source);
      if (unavailable) {
        Alert.alert("Manage subscription", unavailable);
        return;
      }
      setBusy(tier);
      try {
        const nextMe = await checkoutNativeSubscription(tier, me.user.id);
        setMe(nextMe);
      } catch (e: any) {
        if (e instanceof IapPurchaseError && e.code === "E_USER_CANCELLED") {
          void loadMe();
          return;
        }
        if (e instanceof IapPurchaseError && e.code === "E_PURCHASE_FLOW_TIMEOUT") {
          const nextMe = await refreshNativeState();
          if (nextMe?.subscription) return;
          Alert.alert("Couldn't confirm subscription", e.message);
          return;
        }
        Alert.alert("Couldn't start subscription", e?.message ?? "Try again.");
        void loadMe();
      } finally {
        setBusy(null);
      }
    },
    [busy, loadMe, me?.subscription?.source, me?.user.id, refreshNativeState],
  );

  const header = (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <HeaderIconButton icon="chevron-back" onPress={goBack} variant="plain" />
        <Text style={styles.title}>Plan</Text>
        <View style={{ width: 40 }} />
      </View>
    </>
  );

  if (!me) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        {header}
        <View style={styles.iosCenter}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const sub = me.subscription;
  const canManageInStore = sub?.source === nativeSource;
  const isPlanMismatch = me.iapIntegrity.isPlanMismatch;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {header}
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.currentCard}>
          <Text style={styles.cardLabel}>Current plan</Text>
          <Text style={styles.currentName}>{tierLabel(me.tier, me.trial.active)}</Text>
          <Text style={styles.currentMeta}>{currentPlanMeta(me)}</Text>
          {sub && (
            <Text style={styles.currentSource}>via {subscriptionSourceLabel(sub.source)}</Text>
          )}
        </View>

        {isPlanMismatch && (
          <View style={styles.lockCard}>
            <View style={styles.lockIcon}>
              <Ionicons name="lock-closed-outline" size={22} color={colors.primary} />
            </View>
            <Text style={styles.lockTitle}>Restore required</Text>
            <Text style={styles.lockCopy}>
              This Fina account and the subscription on this device do not match.
            </Text>
            <Pressable
              style={({ pressed }) => [
                styles.restoreButton,
                pressed && !busy && { opacity: 0.78 },
                busy && styles.buttonDisabled,
              ]}
              onPress={restoreNativeSubscription}
              disabled={Boolean(busy)}
            >
              {busy === "restore" ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <>
                  <Text style={styles.restoreButtonText}>Restore purchases</Text>
                  <Ionicons name="refresh" size={16} color={colors.onPrimary} />
                </>
              )}
            </Pressable>
          </View>
        )}

        {!isPlanMismatch && (
          <>
            <View style={styles.sectionHead}>
              <Text style={styles.sectionTitle}>Choose a plan</Text>
              <Text style={styles.sectionSub}>
                Payment and confirmation happen in {storeName}.
              </Text>
            </View>

            <View style={styles.planStack}>
              <PlanCard
                tier="pro"
                me={me}
                busy={busy}
                nativeSource={nativeSource}
                onChoose={startNativeCheckout}
              />
              <PlanCard
                tier="max"
                me={me}
                busy={busy}
                nativeSource={nativeSource}
                onChoose={startNativeCheckout}
              />
            </View>
          </>
        )}

        {canManageInStore && (
          <Pressable
            style={({ pressed }) => [
              styles.manageRow,
              pressed && { backgroundColor: colors.surfaceSoft },
            ]}
            onPress={openNativeManagement}
            disabled={Boolean(busy)}
          >
            <View style={styles.manageGlyph}>
              <Ionicons name="card-outline" size={18} color={colors.body} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.manageTitle}>Manage billing</Text>
              <Text style={styles.manageSub}>Open {storeName} subscriptions</Text>
            </View>
            {busy === "manage" ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Ionicons name="chevron-forward" size={16} color={colors.mutedSoft} />
            )}
          </Pressable>
        )}

        <Text style={styles.footnote}>
          {storeName} handles payment, cancellation, and subscription changes.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function PlanCard({
  tier,
  me,
  busy,
  nativeSource,
  onChoose,
}: {
  tier: PaidTier;
  me: Me;
  busy: BusyState;
  nativeSource: SubscriptionSource;
  onChoose: (tier: PaidTier) => void;
}) {
  const copy = PLAN_COPY[tier];
  const action = useMemo(() => planAction(me, tier, nativeSource), [me, nativeSource, tier]);
  const isBusy = busy === tier;
  const disabled = Boolean(busy) || action.disabled;
  const featured = tier === "pro";

  return (
    <View style={[styles.planCard, featured && styles.planCardFeatured]}>
      <View style={styles.planTop}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.planTitleRow}>
            <Text style={styles.planName}>{copy.title}</Text>
            {copy.badge && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{copy.badge}</Text>
              </View>
            )}
          </View>
          <Text style={styles.planSummary}>{copy.summary}</Text>
        </View>
        <View style={styles.priceBlock}>
          <Text style={styles.price}>{PRICING[tier].displayPrice}</Text>
          <Text style={styles.priceUnit}>/ mo</Text>
        </View>
      </View>

      <View style={styles.featureList}>
        {copy.features.map((feature) => (
          <View key={feature} style={styles.featureRow}>
            <Ionicons name="checkmark-circle" size={16} color={colors.primary} />
            <Text style={styles.featureText}>{feature}</Text>
          </View>
        ))}
      </View>

      <Pressable
        style={({ pressed }) => [
          styles.planButton,
          action.kind === "primary" ? styles.primaryButton : styles.secondaryButton,
          disabled && styles.buttonDisabled,
          pressed && !disabled && { opacity: 0.78 },
        ]}
        onPress={() => onChoose(tier)}
        disabled={disabled}
      >
        {isBusy ? (
          <ActivityIndicator
            size="small"
            color={action.kind === "primary" ? colors.onPrimary : colors.primary}
          />
        ) : (
          <>
            <Text
              style={
                action.kind === "primary"
                  ? styles.primaryButtonText
                  : styles.secondaryButtonText
              }
            >
              {action.label}
            </Text>
            {!action.disabled && (
              <Ionicons
                name="arrow-forward"
                size={16}
                color={action.kind === "primary" ? colors.onPrimary : colors.primary}
              />
            )}
          </>
        )}
      </Pressable>
    </View>
  );
}

function currentPlanMeta(me: Me): string {
  const sub = me.subscription;
  const days = trialDaysLeft(me.trial.endsAt);
  if (me.iapIntegrity.isPlanMismatch) {
    return "Subscription restore is required before Fina can continue.";
  }
  if (me.trial.active) {
    const revertsTo = trialRevertsTo(me);
    if (revertsTo) {
      return `${days ?? 0} day${days === 1 ? "" : "s"} left. ${tierLabel(
        revertsTo,
        false,
      )} starts on ${formatShortDate(me.trial.endsAt)}.`;
    }
    return `${days ?? 0} day${days === 1 ? "" : "s"} left. Choose a plan to keep Fina after trial.`;
  }
  if (!sub) return "Free plan. Upgrade to connect banks and use Fina chat.";
  if (sub.pendingTier && sub.pendingTier !== sub.tier) {
    return `${tierLabel(sub.pendingTier, false)} scheduled for ${formatShortDate(
      sub.pendingTierAt ?? sub.currentPeriodEnd,
    )}.`;
  }
  if (sub.cancelAtPeriodEnd) return `Ends on ${formatShortDate(sub.currentPeriodEnd)}.`;
  return `Renews on ${formatShortDate(sub.currentPeriodEnd)}.`;
}

function planAction(
  me: Me,
  tier: PaidTier,
  nativeSource: SubscriptionSource,
): { label: string; disabled: boolean; kind: "primary" | "secondary" } {
  const sub = me.subscription;
  const label = tierLabel(tier, false);
  if (me.iapIntegrity.isPlanMismatch) {
    return { label: "Restore required", disabled: true, kind: "secondary" };
  }
  if (sub?.tier === tier && !sub.pendingTier && !sub.cancelAtPeriodEnd) {
    return { label: "Current plan", disabled: true, kind: "secondary" };
  }
  if (sub?.pendingTier === tier) {
    return { label: "Switch scheduled", disabled: true, kind: "secondary" };
  }
  if (sub?.source && sub.source !== nativeSource) {
    return { label: "Managed elsewhere", disabled: false, kind: "secondary" };
  }
  if (sub?.tier === "max" && tier === "pro") {
    return { label: "Downgrade to Pro", disabled: false, kind: "secondary" };
  }
  if (sub?.tier === "pro" && tier === "max") {
    return { label: "Upgrade to Max", disabled: false, kind: "primary" };
  }
  if (me.trial.active && tier === "pro") {
    return { label: "Keep Pro", disabled: false, kind: "primary" };
  }
  return { label: `Choose ${label}`, disabled: false, kind: "primary" };
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
  iosCenter: {
    flex: 1,
    justifyContent: "center",
    padding: space.lg,
    gap: space.base,
  },
  scroll: {
    padding: space.lg,
    paddingBottom: space.xxl,
    gap: space.base,
  },
  currentCard: {
    backgroundColor: colors.surfaceSoft,
    borderRadius: 16,
    padding: space.lg,
    gap: 5,
  },
  cardLabel: {
    ...type$.captionStrong,
    color: colors.muted,
    textTransform: "uppercase",
  },
  currentName: { ...type$.titleMd, color: colors.ink },
  currentMeta: { ...type$.bodySm, color: colors.body },
  currentSource: { ...type$.bodySm, color: colors.muted },
  lockCard: {
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 16,
    padding: space.lg,
    alignItems: "center",
    gap: space.sm,
  },
  lockIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  lockTitle: { ...type$.titleMd, color: colors.ink, textAlign: "center" },
  lockCopy: { ...type$.bodySm, color: colors.body, textAlign: "center" },
  restoreButton: {
    marginTop: space.xs,
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "stretch",
    borderRadius: 999,
    paddingVertical: 13,
    backgroundColor: colors.primary,
  },
  restoreButtonText: { ...type$.button, color: colors.onPrimary },
  sectionHead: { gap: 4, paddingTop: space.sm },
  sectionTitle: { ...type$.titleMd, color: colors.ink },
  sectionSub: { ...type$.bodySm, color: colors.muted },
  planStack: { gap: space.base },
  planCard: {
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 16,
    padding: space.base,
    gap: space.base,
  },
  planCardFeatured: {
    borderColor: colors.primary,
  },
  planTop: {
    flexDirection: "row",
    gap: space.sm,
    alignItems: "flex-start",
  },
  planTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  planName: { ...type$.titleMd, color: colors.ink },
  badge: {
    backgroundColor: colors.surfaceSoft,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeText: { ...type$.captionStrong, color: colors.primary },
  planSummary: { ...type$.bodySm, color: colors.muted, marginTop: 4 },
  priceBlock: { alignItems: "flex-end" },
  price: { ...type$.titleMd, color: colors.ink },
  priceUnit: { ...type$.caption, color: colors.muted },
  featureList: { gap: 8 },
  featureRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  featureText: { ...type$.bodySm, color: colors.body, flex: 1 },
  planButton: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    paddingVertical: 13,
  },
  primaryButton: {
    backgroundColor: colors.primary,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  secondaryButton: {
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  buttonDisabled: { opacity: 0.55 },
  primaryButtonText: { ...type$.button, color: colors.onPrimary },
  secondaryButtonText: { ...type$.button, color: colors.primary },
  manageRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 16,
    padding: space.base,
  },
  manageGlyph: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  manageTitle: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  manageSub: { ...type$.bodySm, color: colors.muted },
  footnote: { ...type$.caption, color: colors.muted, textAlign: "center" },
});
