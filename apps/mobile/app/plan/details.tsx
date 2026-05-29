import { useEffect, useState, useCallback } from "react";
import { View, Text, Pressable, ActivityIndicator, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router } from "expo-router";
import {
  tierLabel,
  trialDaysLeft,
  trialRevertsTo,
  formatShortDate,
  subscriptionSourceLabel,
  PRICING,
  type MeDTO as Me,
} from "@fina/shared";
import { apiFetch } from "../../src/api/client";
import { openManageBilling } from "../../src/iap/manage";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
import { colors, space, type as type$ } from "../../src/design/tokens";

export default function PlanDetails() {
  const [me, setMe] = useState<Me | null>(null);
  const [openingBilling, setOpeningBilling] = useState(false);

  useEffect(() => {
    apiFetch<Me>("/me").then(setMe).catch(() => {});
  }, []);

  const onManageBilling = useCallback(async () => {
    if (openingBilling) return;
    setOpeningBilling(true);
    try {
      await openManageBilling(me?.subscription?.tier);
    } finally {
      setOpeningBilling(false);
    }
  }, [openingBilling, me?.subscription]);

  const header = (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <HeaderIconButton icon="chevron-back" onPress={() => router.back()} variant="plain" />
        <Text style={styles.title}>Your Plan</Text>
        <View style={{ width: 40 }} />
      </View>
    </>
  );

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
  const days = trialDaysLeft(me.trial.endsAt);
  const revertsTo = trialRevertsTo(me);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {header}
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Current plan</Text>
          <Text style={styles.planName}>{tierLabel(me.tier, me.trial.active)}</Text>
          {me.trial.active && days !== null && (
            <Text style={styles.planMeta}>
              {days} day{days === 1 ? "" : "s"} left
            </Text>
          )}
          {revertsTo && (
            <Text style={styles.revertText}>
              Switches to {tierLabel(revertsTo, false)} on {formatShortDate(me.trial.endsAt)}
            </Text>
          )}
        </View>

        {sub && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Subscription</Text>
            <Text style={styles.subTier}>
              {tierLabel(sub.tier, false)} · {PRICING[sub.tier].displayPrice}/mo
            </Text>
            <Text style={styles.subMeta}>via {subscriptionSourceLabel(sub.source)}</Text>
            <Text style={styles.subMeta}>
              {sub.cancelAtPeriodEnd
                ? `Ends on ${formatShortDate(sub.currentPeriodEnd)}`
                : `Next charge ${formatShortDate(sub.currentPeriodEnd)}`}
            </Text>
          </View>
        )}

        <View style={styles.actions}>
          {sub ? (
            <>
              <Pressable style={styles.btnPrimary} onPress={() => router.push("/plan" as never)}>
                <Text style={styles.btnPrimaryText}>Change plan</Text>
              </Pressable>
              <Pressable
                style={styles.btnOutline}
                onPress={onManageBilling}
                disabled={openingBilling}
              >
                {openingBilling ? (
                  <ActivityIndicator color={colors.primary} />
                ) : (
                  <Text style={styles.btnOutlineText}>Manage billing</Text>
                )}
              </Pressable>
            </>
          ) : (
            <Pressable style={styles.btnPrimary} onPress={() => router.push("/plan" as never)}>
              <Text style={styles.btnPrimaryText}>Choose a plan</Text>
            </Pressable>
          )}
        </View>
      </ScrollView>
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
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  scroll: { padding: space.lg, gap: space.base },
  card: { backgroundColor: colors.surfaceSoft, borderRadius: 14, padding: space.lg, gap: 4 },
  cardLabel: { ...type$.bodySm, color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5 },
  planName: { ...type$.titleSm, color: colors.ink, fontWeight: "700" },
  planMeta: { ...type$.bodySm, color: colors.muted },
  revertText: { ...type$.bodySm, color: colors.navy, marginTop: 4 },
  subTier: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  subMeta: { ...type$.bodySm, color: colors.muted },
  actions: { gap: space.sm, marginTop: space.base },
  btnPrimary: { backgroundColor: colors.primary, borderRadius: 999, paddingVertical: 14, alignItems: "center" },
  btnPrimaryText: { ...type$.bodyMd, color: "#fff", fontWeight: "600" },
  btnOutline: { borderWidth: 1, borderColor: colors.hairline, borderRadius: 999, paddingVertical: 14, alignItems: "center" },
  btnOutlineText: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
});
