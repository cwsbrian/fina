import { useCallback, useState } from "react";
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator, Animated } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { displayName, trialDaysLeft, type MeDTO as Me, type PlaidItemDTO } from "@fina/shared";
import { useSession } from "../../src/auth/client";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { useCollapsingHeader } from "../../src/design/useCollapsingHeader";
import { ActionItemCard } from "../../src/home/ActionItemCard";
import { SpendCard } from "../../src/home/SpendCard";

const HEADER_HEIGHT = 84;

function computeBudgetCap(
  plan: { totalAmount?: number; categoryAllocations?: Array<{ amount: number }> } | null,
): string | null {
  if (!plan) return null;
  if (typeof plan.totalAmount === "number") return plan.totalAmount.toFixed(2);
  if (Array.isArray(plan.categoryAllocations)) {
    const sum = plan.categoryAllocations.reduce((s, c) => s + Number(c.amount ?? 0), 0);
    return sum > 0 ? sum.toFixed(2) : null;
  }
  return null;
}

export default function Home() {
  const { data: session } = useSession();
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [plaidItems, setPlaidItems] = useState<PlaidItemDTO[] | null>(null);
  const [needsReviewCount, setNeedsReviewCount] = useState(0);
  const [pendingInvites, setPendingInvites] = useState(0);
  const [unreadFina, setUnreadFina] = useState(0);
  const [budgetCurrent, setBudgetCurrent] = useState<{
    plan: { totalAmount?: number; categoryAllocations?: Array<{ amount: number }> } | null;
    totalSpent: string;
  } | null>(null);
  const [hasGoal, setHasGoal] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const wsId = await bootstrapActiveWorkspace();
      const meData = await apiFetch<Me>("/me");
      setMe(meData);
      if (!wsId) return;

      await Promise.all([
        apiFetch<{ plaidItems: PlaidItemDTO[] }>(`/workspaces/${wsId}/plaid-items`)
          .then((r) => setPlaidItems(r.plaidItems))
          .catch(() => setPlaidItems([])),
        apiFetch<{ transactions: unknown[] }>(`/workspaces/${wsId}/transactions?needsReview=true&limit=50`)
          .then((r) => setNeedsReviewCount(r.transactions.length))
          .catch(() => setNeedsReviewCount(0)),
        apiFetch<{ invites: unknown[] }>("/me/incoming-invites")
          .then((r) => setPendingInvites(r.invites.length))
          .catch(() => setPendingInvites(0)),
        apiFetch<{ threads: Array<{ unreadCount: number }> }>("/chat/threads")
          .then((r) => setUnreadFina(r.threads.reduce((s, t) => s + (t.unreadCount ?? 0), 0)))
          .catch(() => setUnreadFina(0)),
        apiFetch<{ plan: { totalAmount?: number; categoryAllocations?: Array<{ amount: number }> } | null; totalSpent: string }>(`/workspaces/${wsId}/budget-plans/current`)
          .then((r) => setBudgetCurrent({ plan: r.plan, totalSpent: r.totalSpent }))
          .catch(() => setBudgetCurrent({ plan: null, totalSpent: "0.00" })),
        apiFetch<{ goals: unknown[] }>(`/workspaces/${wsId}/goals`)
          .then((r) => setHasGoal(r.goals.length > 0))
          .catch(() => setHasGoal(false)),
      ]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const greetingName =
    session?.user && me?.user
      ? displayName({ name: me.user.name, email: me.user.email })
      : "";

  const days = me?.trial?.endsAt ? trialDaysLeft(me.trial.endsAt) : null;
  const trialUrgent = !!(me?.trial?.active && days !== null && days <= 5);

  const bankReconnects = (plaidItems ?? []).filter(
    (p) => p.status === "error" || p.errorCode === "ITEM_LOGIN_REQUIRED" || p.errorCode === "PENDING_EXPIRATION",
  );

  const actionItems: Array<{
    key: string;
    icon: Parameters<typeof ActionItemCard>[0]["icon"];
    title: string;
    subtitle?: string;
    href: string;
  }> = [];

  if (bankReconnects.length === 1) {
    actionItems.push({
      key: "bank",
      icon: "alert-circle-outline",
      title: `Reconnect ${bankReconnects[0]!.institutionName}`,
      href: "/banks",
    });
  } else if (bankReconnects.length > 1) {
    actionItems.push({
      key: "bank",
      icon: "alert-circle-outline",
      title: `Reconnect ${bankReconnects.length} banks`,
      href: "/banks",
    });
  }

  if (unreadFina > 0) {
    actionItems.push({
      key: "fina",
      icon: "chatbubble-outline",
      title: `Fina sent you ${unreadFina} message${unreadFina === 1 ? "" : "s"}`,
      href: "/chats",
    });
  }

  if (needsReviewCount > 0) {
    const label = needsReviewCount >= 50 ? "50+" : `${needsReviewCount}`;
    actionItems.push({
      key: "categorize",
      icon: "construct-outline",
      title: `Confirm ${label} categorization${needsReviewCount === 1 ? "" : "s"}`,
      href: "/categorize/inbox",
    });
  }

  if (trialUrgent && days !== null) {
    actionItems.push({
      key: "trial",
      icon: "sparkles-outline",
      title: `Trial ends in ${days} day${days === 1 ? "" : "s"}`,
      href: "/subscriptions",
    });
  }

  if (pendingInvites > 0) {
    actionItems.push({
      key: "invites",
      icon: "mail-outline",
      title: `${pendingInvites} workspace invite${pendingInvites === 1 ? "" : "s"}`,
      href: "/workspace/incoming",
    });
  }

  const hasBudget = budgetCurrent?.plan !== null && budgetCurrent?.plan !== undefined;
  const bankCount = plaidItems?.length ?? 0;
  if (budgetCurrent !== null && !hasBudget) {
    actionItems.push({
      key: "ob-budget",
      icon: "wallet-outline",
      title: "Set a monthly budget",
      subtitle: "Pick a total. Fina tracks every spend.",
      href: "/budget",
    });
  }
  if (plaidItems !== null && bankCount === 0) {
    actionItems.push({
      key: "ob-bank",
      icon: "card-outline",
      title: "Connect a bank",
      subtitle: "Plaid securely imports your transactions.",
      href: "/banks",
    });
  }
  if (hasGoal === false) {
    actionItems.push({
      key: "ob-goal",
      icon: "flag-outline",
      title: "Set your first goal",
      subtitle: "Save for something. Pro feature, free during trial.",
      href: "/(tabs)/goals",
    });
  }

  const insets = useSafeAreaInsets();
  const totalHeader = insets.top + HEADER_HEIGHT;
  const header = useCollapsingHeader(HEADER_HEIGHT);

  return (
    <View style={styles.safe}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: totalHeader }]}
        onScroll={header.onScroll}
        scrollEventThrottle={header.scrollEventThrottle}
      >
        {me?.trial?.active && days !== null && (
          <View style={styles.trialBanner}>
            <Ionicons name="sparkles" size={16} color={colors.navy} />
            <Text style={styles.trialBannerText}>
              Pro trial · {days} day{days === 1 ? "" : "s"} left
            </Text>
          </View>
        )}

        {!me && err && (
          <View style={styles.errCard}>
            <Text style={styles.errTitle}>Couldn't reach Fina</Text>
            <Text style={styles.errBody}>{err}</Text>
            <Pressable
              style={({ pressed }) => [styles.retryBtn, pressed && { opacity: 0.7 }]}
              onPress={() => load()}
            >
              <Text style={styles.retryBtnText}>Try again</Text>
            </Pressable>
          </View>
        )}

        {!me && !err && (
          <View style={{ paddingVertical: space.xxl }}>
            <ActivityIndicator color={colors.primary} />
          </View>
        )}

        {me && (
          <>
            {actionItems.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>Your queue</Text>
                {actionItems.map((it) => (
                  <ActionItemCard
                    key={it.key}
                    icon={it.icon}
                    title={it.title}
                    {...(it.subtitle !== undefined ? { subtitle: it.subtitle } : {})}
                    onPress={() => router.push(it.href as never)}
                  />
                ))}
              </>
            )}

            {budgetCurrent && (
              <SpendCard
                currency="CAD"
                totalSpent={budgetCurrent.totalSpent}
                budgetCap={computeBudgetCap(budgetCurrent.plan)}
              />
            )}
          </>
        )}
      </ScrollView>
      <Animated.View
        style={[
          styles.headerOverlay,
          { top: insets.top, height: HEADER_HEIGHT },
          header.headerStyle,
        ]}
      >
        <View style={styles.head}>
          <View>
            <Text style={styles.title} numberOfLines={1}>
              Hi{greetingName ? `, ${greetingName}` : ""}
            </Text>
            <Text style={styles.subtitle}>Welcome to Fina.</Text>
          </View>
        </View>
      </Animated.View>
      <View style={[styles.statusBarBg, { height: insets.top }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  headerOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 10,
    backgroundColor: colors.canvas,
  },
  statusBarBg: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 11,
    backgroundColor: colors.canvas,
  },
  head: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingTop: 12,
    height: HEADER_HEIGHT,
  },
  title: { ...type$.titleLg, color: colors.ink },
  subtitle: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  scroll: { padding: space.lg, paddingBottom: space.xxl },
  trialBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(143, 184, 232, 0.18)",
    paddingHorizontal: space.base,
    paddingVertical: space.sm,
    borderRadius: 999,
    alignSelf: "flex-start",
    marginBottom: space.lg,
  },
  trialBannerText: {
    ...type$.captionStrong,
    color: colors.navy,
  },
  errCard: {
    backgroundColor: colors.surfaceSoft,
    padding: space.base,
    borderRadius: 14,
    marginVertical: space.base,
  },
  errTitle: { ...type$.titleSm, color: colors.down, marginBottom: 4 },
  errBody: { ...type$.bodySm, color: colors.body },
  sectionTitle: {
    ...type$.captionStrong,
    color: colors.muted,
    textTransform: "uppercase",
    marginBottom: space.sm,
    marginTop: space.base,
  },
  retryBtn: {
    marginTop: space.sm,
    paddingHorizontal: space.base,
    paddingVertical: space.sm,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignSelf: "flex-start",
  },
  retryBtnText: { ...type$.bodySm, color: colors.onPrimary, fontWeight: "600" },
});
