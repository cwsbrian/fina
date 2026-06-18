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
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  IAP_PRICING,
  TIER_LIMITS,
  formatShortDate,
  subscriptionSourceLabel,
  tierLabel,
  trialDaysLeft,
  trialRevertsTo,
  isApiError,
  type ApiErrorCode,
  type MeDTO as Me,
  type PaidTier,
} from "@fina/shared";
import { isUnsyncedIAPPurchaseError } from "../../src/api/billing";
import { apiFetch } from "../../src/api/client";
import {
  billingRecoveryFootnote,
  isBillingLocked,
} from "../../src/billing/recovery-ui";
import { IapPurchaseError } from "../../src/iap/client";
import { nativeBillingUnavailableMessage, openManageBilling } from "../../src/iap/manage";
import {
  copyTextToClipboard,
  hasNativeSubscriptionStoreEntitlementReader,
  listNativeSubscriptionStoreEntitlements,
  presentNativeSubscriptionStoreAndSync,
} from "../../src/iap/native-subscription-store";
import { usesNativeSubscriptionSurface } from "../../src/iap/plan-mode";
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

const PLAN_DEBUG_MARKER = "plan-debug-2026-06-18-storekit-entitlements";

type NativeDebugState = {
  available: boolean;
  checkedAt: string;
  entitlements: Awaited<ReturnType<typeof listNativeSubscriptionStoreEntitlements>> | null;
  error: string | null;
};

function buildPlanDebugPayload(me: Me | null, nativeDebug: NativeDebugState | null): string {
  return JSON.stringify(
    {
      marker: PLAN_DEBUG_MARKER,
      copiedAt: new Date().toISOString(),
      user: me ? { id: me.user.id, email: me.user.email } : null,
      me: me
        ? {
            tier: me.tier,
            trialActive: me.trial.active,
            subscription: me.subscription
              ? {
                  source: me.subscription.source,
                  tier: me.subscription.tier,
                  status: me.subscription.status,
                }
              : null,
            billingRecovery: me.billingRecovery,
            iapIntegrity: me.iapIntegrity,
          }
        : null,
      nativeDebug,
    },
    null,
    2,
  );
}

const IAP_ERROR_MESSAGES = {
  user_mismatch:
    "This App Store sandbox subscription is already tied to another Fina account. Sign in with that Fina account, or use a fresh Sandbox Tester Apple ID.",
  already_subscribed_iap: "This App Store account already has an active Fina subscription.",
  already_subscribed_stripe: "This Fina account is already subscribed through web billing.",
  invalid_receipt: "The App Store receipt could not be verified. Try again.",
  expired_receipt: "The App Store subscription is expired.",
  product_mismatch: "The App Store returned a different subscription product than expected.",
  iap_not_configured: "In-app purchases are not fully configured on the server.",
  platform_unavailable: "In-app purchases are temporarily unavailable.",
} satisfies Partial<Record<ApiErrorCode, string>>;

function purchaseErrorMessage(e: unknown): string {
  if (e instanceof IapPurchaseError) return `[${e.code}] ${e.message}`;
  if (isApiError(e)) {
    const message =
      (IAP_ERROR_MESSAGES as Record<string, string | undefined>)[e.code] ??
      e.message ??
      "Try again.";
    return `[${e.code}] ${message}`;
  }
  if (e instanceof Error) return e.message;
  return "Try again.";
}

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
  const [nativeDebug, setNativeDebug] = useState<NativeDebugState | null>(null);
  const busyRef = useRef<BusyState>(null);
  const nativeSource: SubscriptionSource =
    Platform.OS === "ios" ? "iap_apple" : "iap_google";
  const storeName = Platform.OS === "ios" ? "the App Store" : "Google Play";
  const usesNativeSurface = usesNativeSubscriptionSurface(Platform.OS);

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

  useFocusEffect(
    useCallback(() => {
      void loadMe();
    }, [loadMe]),
  );

  useEffect(() => {
    if (!__DEV__ || Platform.OS !== "ios") return;
    let cancelled = false;
    const available = hasNativeSubscriptionStoreEntitlementReader();
    const checkedAt = new Date().toISOString();
    setNativeDebug({ available, checkedAt, entitlements: null, error: null });
    if (!available) return;

    listNativeSubscriptionStoreEntitlements()
      .then((entitlements) => {
        if (cancelled) return;
        setNativeDebug({ available, checkedAt, entitlements, error: null });
      })
      .catch((e) => {
        if (cancelled) return;
        setNativeDebug({
          available,
          checkedAt,
          entitlements: null,
          error: e instanceof Error ? e.message : String(e),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [me?.user.id]);

  useEffect(() => {
    if (me && isBillingLocked(me)) {
      router.replace("/billing/recovery" as never);
    }
  }, [me, router]);

  const refreshNativeState = useCallback(async (): Promise<Me | null> => {
    return await loadMe();
  }, [loadMe]);

  useEffect(() => {
    if (Platform.OS !== "ios" && Platform.OS !== "android") return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      if (busyRef.current) {
        void refreshNativeState().finally(() => setBusy(null));
        return;
      }
      void loadMe();
    });
    return () => sub.remove();
  }, [loadMe, refreshNativeState]);

  useEffect(() => {
    if ((Platform.OS !== "ios" && Platform.OS !== "android") || !busy) return;
    const timeout = setTimeout(() => {
      void refreshNativeState().finally(() => setBusy(null));
    }, 90_000);
    return () => clearTimeout(timeout);
  }, [busy, refreshNativeState]);

  const openNativeManagement = useCallback(async () => {
    if (busy) return;
    if (!usesNativeSurface && !me?.subscription && Platform.OS === "android") return;
    const unavailable = nativeBillingUnavailableMessage(me?.subscription?.source);
    if (unavailable) {
      Alert.alert("Manage subscription", unavailable);
      return;
    }
    setBusy("manage");
    try {
      if (usesNativeSurface) {
        if (!me?.user.id) {
          Alert.alert("Couldn't open App Store", "Sign in again and try again.");
          return;
        }
        const nextMe = await presentNativeSubscriptionStoreAndSync(me.user.id);
        if (nextMe) {
          setMe(nextMe);
          return;
        }
        await loadMe();
        return;
      }
      await openManageBilling(me?.subscription?.tier, me?.subscription?.source);
      await loadMe();
    } catch (e: any) {
      if (isApiError(e) && e.code === "user_mismatch") {
        await loadMe();
        router.replace("/billing/recovery" as never);
        return;
      }
      if (isUnsyncedIAPPurchaseError(e)) {
        const synced = await syncCurrentNativeSubscriptions().catch(() => null);
        if (synced?.subscription) {
          setMe(synced);
          return;
        }
      }
      const nextMe = await loadMe();
      if (nextMe && isBillingLocked(nextMe)) {
        router.replace("/billing/recovery" as never);
        return;
      }
      if (nextMe?.subscription) return;
      Alert.alert("Couldn't update subscription", purchaseErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [busy, loadMe, me?.subscription, me?.user.id, router, usesNativeSurface]);

  const copyPlanDebug = useCallback(async () => {
    try {
      const mode = await copyTextToClipboard(buildPlanDebugPayload(me, nativeDebug));
      if (mode === "clipboard") Alert.alert("Debug copied", "Plan debug copied to clipboard.");
    } catch (e) {
      Alert.alert("Couldn't copy debug", e instanceof Error ? e.message : "Try again.");
    }
  }, [me, nativeDebug]);

  const restoreNativePurchases = useCallback(async () => {
    if (busy) return;
    const unavailable = nativeBillingUnavailableMessage(me?.subscription?.source);
    if (unavailable) {
      Alert.alert("Restore purchases", unavailable);
      return;
    }
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
    } catch (e: any) {
      Alert.alert("Restore failed", purchaseErrorMessage(e));
      void loadMe();
    } finally {
      setBusy(null);
    }
  }, [busy, loadMe, me?.subscription?.source, storeName]);

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
        const message = purchaseErrorMessage(e);
        console.warn("[iap.checkout] failed", {
          tier,
          code: e instanceof IapPurchaseError || isApiError(e) ? e.code : e?.code,
          message: e?.message,
          error: e,
        });
        if (e instanceof IapPurchaseError && e.code === "E_USER_CANCELLED") {
          void loadMe();
          return;
        }
        if (e instanceof IapPurchaseError && e.code === "E_PURCHASE_FLOW_TIMEOUT") {
          const nextMe = await refreshNativeState();
          if (nextMe?.subscription) return;
          Alert.alert("Couldn't confirm subscription", message);
          return;
        }
        if (isApiError(e) && e.code === "user_mismatch") {
          await loadMe();
          router.replace("/billing/recovery" as never);
          return;
        }
        if (isUnsyncedIAPPurchaseError(e)) {
          const synced = await syncCurrentNativeSubscriptions().catch(() => null);
          if (synced?.subscription) {
            setMe(synced);
            return;
          }
        }
        const nextMe = await loadMe();
        if (nextMe && isBillingLocked(nextMe)) {
          router.replace("/billing/recovery" as never);
          return;
        }
        if (nextMe?.subscription) return;
        Alert.alert("Couldn't start subscription", message);
      } finally {
        setBusy(null);
      }
    },
    [busy, loadMe, me?.subscription?.source, me?.user.id, refreshNativeState, router],
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
  const canManageInStore = !usesNativeSurface && sub?.source === nativeSource;
  const isPlanMismatch = isBillingLocked(me);

  if (isPlanMismatch) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        {header}
        <View style={styles.iosCenter}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

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

        {__DEV__ && (
          <Pressable
            style={({ pressed }) => [styles.debugBox, pressed && { opacity: 0.72 }]}
            onPress={copyPlanDebug}
          >
            <Text style={styles.debugTitle}>Plan debug</Text>
            <Text style={styles.debugText}>tap: copy debug payload</Text>
            <Text style={styles.debugText}>marker: {PLAN_DEBUG_MARKER}</Text>
            <Text style={styles.debugText}>user: {me.user.email} / {me.user.id}</Text>
            <Text style={styles.debugText}>
              me: {me.tier}, trial: {String(me.trial.active)}
            </Text>
            <Text style={styles.debugText}>
              sub: {sub ? `${sub.source}/${sub.tier}/${sub.status}` : "null"}
            </Text>
            <Text style={styles.debugText}>
              billingRecovery:{" "}
              {JSON.stringify({
                locked: me.billingRecovery.locked,
                action: me.billingRecovery.action,
                source: me.billingRecovery.source,
                reason: me.billingRecovery.reason,
                lastCheckedAt: me.billingRecovery.lastCheckedAt,
              })}
            </Text>
            <Text style={styles.debugText}>
              iapIntegrity:{" "}
              {JSON.stringify({
                isPlanMismatch: me.iapIntegrity.isPlanMismatch,
                requiresCheck: me.iapIntegrity.requiresCheck,
                lastCheckedAt: me.iapIntegrity.lastCheckedAt,
              })}
            </Text>
            <Text style={styles.debugText}>
              nativeEntitlementReader:{" "}
              {nativeDebug ? String(nativeDebug.available) : "null"}
            </Text>
            <Text style={styles.debugText}>
              nativeCheckedAt: {nativeDebug?.checkedAt ?? "null"}
            </Text>
            <Text style={styles.debugText}>
              nativeEntitlements: {JSON.stringify(nativeDebug?.entitlements ?? null)}
            </Text>
            <Text style={styles.debugText}>
              nativeError: {nativeDebug?.error ?? "null"}
            </Text>
          </Pressable>
        )}

        {usesNativeSurface && (
          <View style={styles.nativeCard}>
            <View style={styles.nativeIcon}>
              <Ionicons name="logo-apple" size={22} color={colors.primary} />
            </View>
            <Text style={styles.nativeTitle}>App Store subscription</Text>
            <Text style={styles.nativeCopy}>
              Start, change, or cancel your Fina subscription in the App Store.
            </Text>
            <Pressable
              style={({ pressed }) => [
                styles.restoreButton,
                pressed && !busy && { opacity: 0.78 },
                busy && styles.buttonDisabled,
              ]}
              onPress={openNativeManagement}
              disabled={Boolean(busy)}
            >
              {busy === "manage" ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <>
                  <Text style={styles.restoreButtonText}>Open App Store</Text>
                  <Ionicons name="open-outline" size={16} color={colors.onPrimary} />
                </>
              )}
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.nativeSecondaryButton,
                pressed && !busy && { opacity: 0.78 },
                busy && styles.buttonDisabled,
              ]}
              onPress={restoreNativePurchases}
              disabled={Boolean(busy)}
            >
              {busy === "restore" ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <>
                  <Text style={styles.nativeSecondaryText}>Restore purchases</Text>
                  <Ionicons name="refresh" size={16} color={colors.primary} />
                </>
              )}
            </Pressable>
          </View>
        )}

        {!usesNativeSurface && (
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
          {billingRecoveryFootnote(me, storeName)}
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
          <Text style={styles.price}>{IAP_PRICING[tier].displayPrice}</Text>
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
  if (isBillingLocked(me)) {
    return "Billing recovery is required before Fina can continue.";
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
  if (isBillingLocked(me)) {
    return { label: "Recovery required", disabled: true, kind: "secondary" };
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
  debugBox: {
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 12,
    padding: space.sm,
    gap: 4,
    backgroundColor: colors.surfaceSoft,
  },
  debugTitle: { ...type$.captionStrong, color: colors.ink },
  debugText: { ...type$.caption, color: colors.muted },
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
  nativeCard: {
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 16,
    padding: space.lg,
    alignItems: "center",
    gap: space.sm,
  },
  nativeIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  nativeTitle: { ...type$.titleMd, color: colors.ink, textAlign: "center" },
  nativeCopy: { ...type$.bodySm, color: colors.body, textAlign: "center" },
  nativeSecondaryButton: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "stretch",
    borderRadius: 999,
    paddingVertical: 13,
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  nativeSecondaryText: { ...type$.button, color: colors.primary },
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
