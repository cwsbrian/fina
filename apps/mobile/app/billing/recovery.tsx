import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  isApiError,
  subscriptionSourceLabel,
  tierLabel,
  type ApiErrorCode,
  type MeDTO as Me,
} from "@fina/shared";

import { postBillingSync } from "../../src/api/billing";
import { apiFetch } from "../../src/api/client";
import { unregisterForPushNotifications } from "../../src/api/push";
import { signOut } from "../../src/auth/client";
import {
  billingRecoveryButtonLabel,
  billingRecoveryFootnote,
  billingRecoveryLockCopy,
  isBillingLocked,
} from "../../src/billing/recovery-ui";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { env } from "../../src/env";
import { IapPurchaseError } from "../../src/iap/client";
import { copyTextToClipboard } from "../../src/iap/native-subscription-store";
import {
  fetchMeWithNativeSubscriptionSync,
  restoreCurrentNativeSubscriptions,
} from "../../src/iap/sync";
import { clearActiveWorkspaceId } from "../../src/workspace/active";

type BusyState = "restore" | "sign-out" | null;

const RECOVERY_DEBUG_MARKER = "billing-recovery-debug-2026-06-18";

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

function errorDebugPayload(e: unknown): unknown {
  if (e instanceof IapPurchaseError) {
    return { type: "iap", code: e.code, recoverable: e.recoverable, message: e.message };
  }
  if (isApiError(e)) {
    return { type: "api", status: e.status, code: e.code, message: e.message ?? null };
  }
  if (e instanceof Error) return { type: "error", message: e.message };
  return e;
}

function buildRecoveryDebugPayload(
  me: Me | null,
  lastLoadedAt: string | null,
  lastRecoveryError: unknown,
): string {
  return JSON.stringify(
    {
      marker: RECOVERY_DEBUG_MARKER,
      copiedAt: new Date().toISOString(),
      loadedAt: lastLoadedAt,
      api: env.EXPO_PUBLIC_API_URL,
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
      lastRecoveryError: errorDebugPayload(lastRecoveryError),
    },
    null,
    2,
  );
}

export default function BillingRecoveryScreen() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState<BusyState>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);
  const [lastRecoveryError, setLastRecoveryError] = useState<unknown>(null);
  const busyRef = useRef<BusyState>(null);
  const storeName = Platform.OS === "ios" ? "the App Store" : "Google Play";

  const loadMe = useCallback(async (): Promise<Me | null> => {
    const fetchMe =
      Platform.OS === "ios" || Platform.OS === "android"
        ? fetchMeWithNativeSubscriptionSync
        : () => apiFetch<Me>("/me");
    try {
      const nextMe = await fetchMe();
      setMe(nextMe);
      setLastLoadedAt(new Date().toISOString());
      return nextMe;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useFocusEffect(
    useCallback(() => {
      void loadMe();
    }, [loadMe]),
  );

  useEffect(() => {
    if (!me || isBillingLocked(me)) return;
    router.replace("/(tabs)" as never);
  }, [me, router]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active" || busyRef.current) return;
      void loadMe();
    });
    return () => sub.remove();
  }, [loadMe]);

  const restoreBilling = useCallback(async () => {
    if (busy || !me) return;
    const action = me.billingRecovery?.action ?? null;
    if (!action) {
      Alert.alert(
        "Recovery unavailable",
        "We could not determine where this subscription is managed. Contact support.",
      );
      return;
    }

    setBusy("restore");
    setLastRecoveryError(null);
    try {
      const nextMe =
        action === "sync_stripe"
          ? await postBillingSync()
          : await restoreCurrentNativeSubscriptions();
      if (!nextMe) {
        Alert.alert(
          "No subscription found",
          `No active Fina subscription was found in ${storeName}.`,
        );
        await loadMe();
        return;
      }

      setMe(nextMe);
      if (isBillingLocked(nextMe)) {
        Alert.alert(
          "Recovery incomplete",
          "We could not confirm that this Fina account and billing provider match yet.",
        );
        return;
      }
      router.replace("/(tabs)" as never);
    } catch (e) {
      setLastRecoveryError(e);
      Alert.alert("Recovery failed", purchaseErrorMessage(e));
      void loadMe();
    } finally {
      setBusy(null);
    }
  }, [busy, loadMe, me, router, storeName]);

  const copyRecoveryDebug = useCallback(async () => {
    try {
      const mode = await copyTextToClipboard(
        buildRecoveryDebugPayload(me, lastLoadedAt, lastRecoveryError),
      );
      if (mode === "clipboard") Alert.alert("Debug copied", "Recovery debug copied to clipboard.");
    } catch (e) {
      Alert.alert("Couldn't copy debug", e instanceof Error ? e.message : "Try again.");
    }
  }, [lastLoadedAt, lastRecoveryError, me]);

  const useAnotherAccount = useCallback(() => {
    if (busy) return;
    Alert.alert("Use another account", "Sign out and choose a different Fina account?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: async () => {
          setBusy("sign-out");
          try {
            await unregisterForPushNotifications();
            await signOut();
            await clearActiveWorkspaceId();
            router.replace("/(auth)/sign-in" as never);
          } catch (e) {
            Alert.alert(
              "Couldn't sign out",
              e instanceof Error ? e.message : "Try again in a moment.",
            );
            setBusy(null);
          }
        },
      },
    ]);
  }, [busy, router]);

  const header = <Stack.Screen options={{ headerShown: false }} />;

  if (!me) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        {header}
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const sub = me.subscription;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {header}
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.card}>
          <View style={styles.icon}>
            <Ionicons name="lock-closed-outline" size={24} color={colors.primary} />
          </View>
          <Text style={styles.cardTitle}>Recovery required</Text>
          <Text style={styles.copy}>{billingRecoveryLockCopy(me)}</Text>

          <View style={styles.details}>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Signed in</Text>
              <Text style={styles.detailValue}>{me.user.email}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Current plan</Text>
              <Text style={styles.detailValue}>{tierLabel(me.tier, me.trial.active)}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Billing source</Text>
              <Text style={styles.detailValue}>
                {sub ? subscriptionSourceLabel(sub.source) : "Unknown"}
              </Text>
            </View>
          </View>

          {__DEV__ && (
            <Pressable
              style={({ pressed }) => [styles.debugBox, pressed && { opacity: 0.72 }]}
              onPress={copyRecoveryDebug}
            >
              <Text style={styles.debugTitle}>Recovery debug</Text>
              <Text style={styles.debugText}>tap: copy debug payload</Text>
              <Text style={styles.debugText}>marker: {RECOVERY_DEBUG_MARKER}</Text>
              <Text style={styles.debugText}>loadedAt: {lastLoadedAt ?? "null"}</Text>
              <Text style={styles.debugText}>api: {env.EXPO_PUBLIC_API_URL}</Text>
              <Text style={styles.debugText}>
                user: {me.user.email} / {me.user.id}
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
                lastRecoveryError: {JSON.stringify(errorDebugPayload(lastRecoveryError))}
              </Text>
            </Pressable>
          )}

          <Pressable
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && !busy && { opacity: 0.78 },
              busy && styles.buttonDisabled,
            ]}
            onPress={restoreBilling}
            disabled={Boolean(busy)}
          >
            {busy === "restore" ? (
              <ActivityIndicator size="small" color={colors.onPrimary} />
            ) : (
              <>
                <Text style={styles.primaryButtonText}>
                  {billingRecoveryButtonLabel(me)}
                </Text>
                <Ionicons name="refresh" size={16} color={colors.onPrimary} />
              </>
            )}
          </Pressable>

          <Pressable
            style={({ pressed }) => [
              styles.secondaryButton,
              pressed && !busy && { opacity: 0.78 },
              busy && styles.buttonDisabled,
            ]}
            onPress={useAnotherAccount}
            disabled={Boolean(busy)}
          >
            {busy === "sign-out" ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <>
                <Text style={styles.secondaryButtonText}>Use another account</Text>
                <Ionicons name="log-out-outline" size={16} color={colors.primary} />
              </>
            )}
          </Pressable>
        </View>

        <Text style={styles.footnote}>{billingRecoveryFootnote(me, storeName)}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  scroll: {
    padding: space.base,
    paddingBottom: space.xxl,
    gap: space.base,
  },
  card: {
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 16,
    padding: space.lg,
    alignItems: "center",
    gap: space.sm,
  },
  icon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: { ...type$.titleMd, color: colors.ink, textAlign: "center" },
  copy: { ...type$.bodySm, color: colors.body, textAlign: "center" },
  details: {
    alignSelf: "stretch",
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 8,
    padding: space.sm,
    gap: 8,
  },
  detailRow: { gap: 2 },
  detailLabel: { ...type$.captionStrong, color: colors.muted },
  detailValue: { ...type$.bodySm, color: colors.ink },
  debugBox: {
    alignSelf: "stretch",
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 8,
    padding: space.sm,
    backgroundColor: colors.surfaceSoft,
    gap: 3,
  },
  debugTitle: { ...type$.captionStrong, color: colors.ink },
  debugText: { ...type$.caption, color: colors.body },
  primaryButton: {
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
  primaryButtonText: { ...type$.button, color: colors.onPrimary },
  secondaryButton: {
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
  secondaryButtonText: { ...type$.button, color: colors.primary },
  buttonDisabled: { opacity: 0.55 },
  footnote: { ...type$.caption, color: colors.muted, textAlign: "center" },
});
