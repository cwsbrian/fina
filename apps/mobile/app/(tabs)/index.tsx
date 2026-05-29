import { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Animated,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  displayName,
  trialDaysLeft,
  tierLabel,
  trialRevertsTo,
  formatShortDate,
  tierAtLeast,
  type MeDTO as Me,
  type CategoryDTO,
  type TransactionDTO,
  type ChatThreadDTO,
  type PlaidItemDTO,
  type Tier,
} from "@fina/shared";
import { useSession } from "../../src/auth/client";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { useCollapsingHeader } from "../../src/design/useCollapsingHeader";
import { ActionItemCard } from "../../src/home/ActionItemCard";
import { formatMoney } from "../../src/format/money";
import { categoryMeta } from "../../src/categories/meta";

const HEADER_HEIGHT = 84;
const CURRENCY = "CAD";

type SpendByCategory = { categoryId: string; categoryName?: string; spent: number };
type BudgetCurrent = {
  plan: {
    totalAmount?: number;
    categoryAllocations?: Array<{ categoryId: string; amount: number }>;
  } | null;
  totalSpent: string;
  spendByCategory: SpendByCategory[];
};

type ChatThreadWithPreview = ChatThreadDTO & {
  messageCount: number;
  firstMessagePreview: string | null;
};

type GoalSummary = {
  id: string;
  title: string;
  icon: string | null;
  color: string | null;
  savedAmount: string;
  targetAmount: string;
  dueDate: string;
};

function computeBudgetCap(plan: BudgetCurrent["plan"]): number | null {
  if (!plan) return null;
  if (typeof plan.totalAmount === "number") return plan.totalAmount;
  if (Array.isArray(plan.categoryAllocations)) {
    const sum = plan.categoryAllocations.reduce(
      (s, c) => s + Number(c.amount ?? 0),
      0,
    );
    return sum > 0 ? sum : null;
  }
  return null;
}

function monthName(date: Date): string {
  return date.toLocaleDateString("en-CA", { month: "long" });
}

function formatMonthDay(date: Date): string {
  return date.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}

/** Split a decimal-string amount into the formatted dollar portion (no
 *  decimals, with currency symbol + thousands separators) and the ".NN"
 *  cents suffix, so the hero can render them at different sizes. */
function splitMoney(amount: string, currency = CURRENCY): { dollars: string; cents: string } {
  const n = Number(amount);
  if (!Number.isFinite(n)) return { dollars: amount, cents: "" };
  const abs = Math.abs(n);
  const intDollars = Math.floor(abs);
  const cents = Math.round((abs - intDollars) * 100);
  const intl = new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return {
    dollars: intl.format(intDollars),
    cents: `.${cents.toString().padStart(2, "0")}`,
  };
}

/** Friendly "Just now / 5m / 2h / yesterday / May 12" relative time for
 *  the Brief card eyebrow. */
function relativeTime(iso: string | null, now = new Date()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diffSec = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (diffSec < 60) return "Just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay === 1) return "Yesterday";
  if (diffDay < 7) return `${diffDay}d`;
  return new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-CA", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export default function Home() {
  const { data: session } = useSession();
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [budgetCurrent, setBudgetCurrent] = useState<BudgetCurrent | null>(null);
  const [latestUnboundThread, setLatestUnboundThread] = useState<ChatThreadWithPreview | null>(null);
  const [needsReviewCount, setNeedsReviewCount] = useState(0);
  const [recentTxs, setRecentTxs] = useState<TransactionDTO[] | null>(null);
  const [categories, setCategories] = useState<Record<string, CategoryDTO>>({});
  const [goals, setGoals] = useState<GoalSummary[]>([]);
  const [analysis, setAnalysis] = useState<{
    income: number;
    net: number;
    prevNet: number | null;
  } | null>(null);
  const [plaidItems, setPlaidItems] = useState<PlaidItemDTO[] | null>(null);
  const [unreadFina, setUnreadFina] = useState(0);
  const [latestUnreadThreadId, setLatestUnreadThreadId] = useState<string | null>(null);
  const [pendingInvites, setPendingInvites] = useState(0);
  const [hasGoal, setHasGoal] = useState<boolean | null>(null);
  const [hasChattedState, setHasChattedState] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const wsId = await bootstrapActiveWorkspace();
      const meData = await apiFetch<Me>("/me");
      setMe(meData);
      if (!wsId) return;

      await Promise.all([
        apiFetch<BudgetCurrent>(`/workspaces/${wsId}/budget-plans/current`)
          .then((r) =>
            setBudgetCurrent({
              plan: r.plan,
              totalSpent: r.totalSpent,
              spendByCategory: Array.isArray(r.spendByCategory) ? r.spendByCategory : [],
            }),
          )
          .catch(() =>
            setBudgetCurrent({ plan: null, totalSpent: "0.00", spendByCategory: [] }),
          ),
        apiFetch<{ threads: ChatThreadWithPreview[] }>("/chat/threads")
          .then((r) => {
            // Latest workspace-less thread = the one the Brief card opens.
            // Threads are returned newest-first by lastMessageAt.
            const unbound = r.threads.find((t) => t.workspaceId === null) ?? null;
            setLatestUnboundThread(unbound);
            setUnreadFina(
              r.threads.reduce((s, t) => s + (t.unreadCount ?? 0), 0),
            );
            // Threads are returned newest-first by lastMessageAt; the first
            // one with unread messages is what the Home action card opens.
            setLatestUnreadThreadId(
              r.threads.find((t) => (t.unreadCount ?? 0) > 0)?.id ?? null,
            );
            // hasChatted = any thread (across all workspaces / unbound) has
            // a user-role first message preview — i.e. the user typed at
            // least once. Daily-brief threads carry only assistant messages
            // so firstMessagePreview stays null for them.
            setHasChattedState(
              r.threads.some((t) => t.firstMessagePreview !== null),
            );
          })
          .catch(() => {
            setLatestUnboundThread(null);
            setUnreadFina(0);
            setLatestUnreadThreadId(null);
            setHasChattedState(false);
          }),
        apiFetch<{ plaidItems: PlaidItemDTO[] }>(`/workspaces/${wsId}/plaid-items`)
          .then((r) => setPlaidItems(r.plaidItems))
          .catch(() => setPlaidItems([])),
        apiFetch<{ invites: unknown[] }>("/me/incoming-invites")
          .then((r) => setPendingInvites(r.invites.length))
          .catch(() => setPendingInvites(0)),
        apiFetch<{ goals: GoalSummary[] }>(`/workspaces/${wsId}/goals`)
          .then((r) => {
            // Surface up to 3 active (non-archived) goals on Home.
            const active = r.goals
              .filter((g) => !(g as { archivedAt?: string | null }).archivedAt)
              .slice(0, 3);
            setGoals(active);
            setHasGoal(r.goals.length > 0);
          })
          .catch(() => {
            setGoals([]);
            setHasGoal(false);
          }),
        apiFetch<{ transactions: unknown[] }>(
          `/workspaces/${wsId}/transactions?needsReview=true&limit=50`,
        )
          .then((r) => setNeedsReviewCount(r.transactions.length))
          .catch(() => setNeedsReviewCount(0)),
        apiFetch<{ transactions: TransactionDTO[] }>(
          `/workspaces/${wsId}/transactions?limit=3`,
        )
          .then((r) => setRecentTxs(r.transactions))
          .catch(() => setRecentTxs([])),
        apiFetch<{ categories: CategoryDTO[] }>(`/workspaces/${wsId}/categories`)
          .then((r) =>
            setCategories(Object.fromEntries(r.categories.map((c) => [c.id, c]))),
          )
          .catch(() => setCategories({})),
        apiFetch<{
          current: { income: number; spend: number; net: number };
          previous: { net: number } | null;
        }>(`/workspaces/${wsId}/analysis`)
          .then((r) =>
            setAnalysis({
              income: r.current.income,
              net: r.current.net,
              prevNet: r.previous?.net ?? null,
            }),
          )
          .catch(() => setAnalysis(null)),
      ]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const greetingName =
    session?.user && me?.user
      ? displayName({ name: me.user.name, email: me.user.email })
      : "";

  const days = me?.trial?.endsAt ? trialDaysLeft(me.trial.endsAt) : null;
  const revertsTo = me ? trialRevertsTo(me) : null;

  const insets = useSafeAreaInsets();
  const totalHeader = insets.top + HEADER_HEIGHT;
  const header = useCollapsingHeader(HEADER_HEIGHT);

  // ── Hero math ──────────────────────────────────────────────
  const now = new Date();
  const monthLabel = monthName(now);
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const daysLeftInMonth = Math.max(
    0,
    Math.ceil((lastOfMonth.getTime() - now.getTime()) / 86_400_000),
  );

  const spentNum = budgetCurrent ? Number(budgetCurrent.totalSpent) : 0;
  const cap = budgetCurrent ? computeBudgetCap(budgetCurrent.plan) : null;
  const remainingNum = cap !== null ? cap - spentNum : null;
  const pct = cap && cap > 0 ? Math.min(999, (spentNum / cap) * 100) : 0;
  const over = pct > 100;
  const spentSplit = splitMoney(spentNum.toFixed(2));
  const capDisplay =
    cap !== null ? formatMoney(cap.toFixed(2), CURRENCY).display : null;
  const remainingDisplay =
    remainingNum !== null
      ? formatMoney(Math.abs(remainingNum).toFixed(2), CURRENCY).display
      : null;

  // ── Top categories (top 4 by spend) ────────────────────────
  const planAllocByCat = new Map<string, number>();
  if (budgetCurrent?.plan?.categoryAllocations) {
    for (const a of budgetCurrent.plan.categoryAllocations) {
      planAllocByCat.set(a.categoryId, Number(a.amount));
    }
  }
  const topCategories = (budgetCurrent?.spendByCategory ?? [])
    .slice()
    .sort((a, b) => Number(b.spent) - Number(a.spent))
    .slice(0, 4);

  // ── Action Items derive ────────────────────────────────────
  const bankReconnects = (plaidItems ?? []).filter(
    (p) =>
      p.status === "error" ||
      p.errorCode === "ITEM_LOGIN_REQUIRED" ||
      p.errorCode === "PENDING_EXPIRATION",
  );
  const trialUrgent = !!(me?.trial?.active && days !== null && days <= 5);
  const hasBudget =
    budgetCurrent?.plan !== null && budgetCurrent?.plan !== undefined;
  const bankCount = plaidItems?.length ?? 0;
  // Effective tier: trial active grants Pro features regardless of base tier.
  const effectiveTier: Tier = me?.trial?.active ? "pro" : (me?.tier ?? "free");
  const canConnectBanks = tierAtLeast(effectiveTier, "lite");
  const canUseGoals = tierAtLeast(effectiveTier, "pro");
  // Has the user chatted at least once? See setHasChattedState above.
  const hasChatted = hasChattedState;

  type ActionItem = {
    key: string;
    icon: keyof typeof Ionicons.glyphMap;
    title: string;
    subtitle?: string;
    href: string;
  };
  const actionItems: ActionItem[] = [];

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
      // Open the most recent unread thread directly. Fall back to the
      // chat history if we somehow don't know which thread (shouldn't
      // happen — unreadFina > 0 implies at least one unread thread).
      href: latestUnreadThreadId
        ? `/(tabs)/chat?thread=${latestUnreadThreadId}`
        : "/chats",
    });
  }

  if (needsReviewCount > 0) {
    const label = needsReviewCount >= 50 ? "50+" : `${needsReviewCount}`;
    actionItems.push({
      key: "categorize",
      icon: "construct-outline",
      title: `Confirm ${label} categorization${needsReviewCount === 1 ? "" : "s"}`,
      subtitle: "Fina auto-categorized these — confirm or change.",
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

  if (budgetCurrent !== null && !hasBudget) {
    actionItems.push({
      key: "ob-budget",
      icon: "wallet-outline",
      title: "Set a monthly budget",
      subtitle: "Pick a total. Fina tracks every spend.",
      href: "/budget",
    });
  }
  // Connect a bank — gated to Lite+ (Free tier can't connect Plaid items).
  if (plaidItems !== null && bankCount === 0 && canConnectBanks) {
    actionItems.push({
      key: "ob-bank",
      icon: "card-outline",
      title: "Connect a bank",
      subtitle: "Plaid securely imports your transactions.",
      href: "/banks",
    });
  }
  // Try chatting with Fina — Pro feature; hides once the user has typed
  // at least once. (Trial grants effective Pro so the card shows.)
  if (canUseGoals && !hasChatted) {
    actionItems.push({
      key: "ob-chat",
      icon: "chatbubble-ellipses-outline",
      title: "Chat with Fina",
      subtitle: "Ask anything about your spending — Fina answers.",
      href: "/(tabs)/chat",
    });
  }
  // Set a goal — Pro only.
  if (hasGoal === false && canUseGoals) {
    actionItems.push({
      key: "ob-goal",
      icon: "flag-outline",
      title: "Set your first goal",
      subtitle: "Save for something. Pro feature, free during trial.",
      href: "/(tabs)/goals",
    });
  }

  // ── Section gating ─────────────────────────────────────────
  // Hero (This month) requires real spending data — show only when
  // we have at least one transaction this month.
  const heroVisible = budgetCurrent !== null && spentNum > 0;

  return (
    <View style={styles.safe}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: totalHeader }]}
        onScroll={header.onScroll}
        scrollEventThrottle={header.scrollEventThrottle}
      >
        {me?.trial?.active && days !== null && (
          <View style={styles.trialBannerWrap}>
            <View style={styles.trialBanner}>
              <Ionicons name="sparkles" size={16} color={colors.navy} />
              <Text style={styles.trialBannerText}>
                Pro trial · {days} day{days === 1 ? "" : "s"} left
              </Text>
            </View>
            {revertsTo && (
              <Text style={styles.trialRevertText}>
                Switches to {tierLabel(revertsTo, false)} on {formatShortDate(me.trial.endsAt)}
              </Text>
            )}
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
            {/* 2. Hero — month spending; only when there is actual spend */}
            {heroVisible && (
              <View style={styles.hero}>
                <Text style={styles.heroLabel}>{monthLabel} spending</Text>
                <Text style={styles.heroValue}>
                  {spentSplit.dollars}
                  <Text style={styles.heroValueDecimal}>{spentSplit.cents}</Text>
                </Text>
                {cap !== null && capDisplay && remainingDisplay ? (
                  <View style={styles.heroMeta}>
                    <Text style={styles.heroMetaText}>of {capDisplay} budget</Text>
                    <View style={styles.heroMetaDot} />
                    <Text
                      style={[
                        styles.heroMetaTextStrong,
                        { color: over ? colors.down : colors.up },
                      ]}
                    >
                      {over
                        ? `${remainingDisplay} over`
                        : `${remainingDisplay} left`}
                    </Text>
                  </View>
                ) : (
                  <Pressable onPress={() => router.push("/budget" as never)}>
                    <Text style={styles.heroCta}>Set a budget →</Text>
                  </Pressable>
                )}
                {cap !== null && (
                  <>
                    <View style={styles.heroBarTrack}>
                      <View
                        style={[
                          styles.heroBarFill,
                          {
                            width: `${Math.min(100, pct)}%`,
                            backgroundColor: over ? colors.down : colors.primary,
                          },
                        ]}
                      />
                    </View>
                    <View style={styles.heroAxis}>
                      <Text style={styles.heroAxisText}>
                        {formatMonthDay(firstOfMonth)}
                      </Text>
                      <Text style={styles.heroAxisDot}>·</Text>
                      <Text style={styles.heroAxisText}>
                        {daysLeftInMonth} day{daysLeftInMonth === 1 ? "" : "s"} left
                      </Text>
                      <Text style={styles.heroAxisDot}>·</Text>
                      <Text style={styles.heroAxisText}>
                        {formatMonthDay(lastOfMonth)}
                      </Text>
                    </View>
                  </>
                )}
              </View>
            )}

            {/* Action Items — what needs the user's attention */}
            {actionItems.length > 0 && (
              <View style={{ marginTop: space.base }}>
                <Text style={styles.eyebrow}>Your queue</Text>
                {actionItems.map((it) => (
                  <ActionItemCard
                    key={it.key}
                    icon={it.icon}
                    title={it.title}
                    {...(it.subtitle ? { subtitle: it.subtitle } : {})}
                    onPress={() => router.push(it.href as never)}
                  />
                ))}
              </View>
            )}

            {/* 3. Brief card — only when there's an unread brief to read */}
            {latestUnboundThread && latestUnboundThread.unreadCount > 0 && (
              <Pressable
                style={({ pressed }) => [styles.briefCard, pressed && { opacity: 0.85 }]}
                onPress={() =>
                  router.push(
                    `/(tabs)/chat?thread=${latestUnboundThread.id}` as never,
                  )
                }
              >
                <View style={styles.briefHead}>
                  <View style={styles.briefEyebrow}>
                    <View style={styles.briefDot} />
                    <Text style={styles.briefEyebrowText}>Fina · Morning brief</Text>
                  </View>
                  <Text style={styles.briefTime}>
                    {relativeTime(
                      latestUnboundThread.lastMessageAt ?? latestUnboundThread.createdAt,
                    )}
                  </Text>
                </View>
                {latestUnboundThread.firstMessagePreview ? (
                  <Text style={styles.briefBody} numberOfLines={3}>
                    {latestUnboundThread.firstMessagePreview}
                  </Text>
                ) : (
                  <Text style={styles.briefBody} numberOfLines={3}>
                    Open chat to see what Fina has for you.
                  </Text>
                )}
                <View style={styles.briefFoot}>
                  {needsReviewCount > 0 ? (
                    <Text style={styles.briefMeta}>
                      {needsReviewCount >= 50 ? "50+" : needsReviewCount} to sort
                    </Text>
                  ) : (
                    <View />
                  )}
                  <View style={styles.briefCta}>
                    <Text style={styles.briefCtaText}>Open</Text>
                    <Ionicons
                      name="chevron-forward"
                      size={14}
                      color={colors.primary}
                    />
                  </View>
                </View>
              </Pressable>
            )}

            {/* 4. Goals summary — only when at least one active goal exists */}
            {goals.length > 0 && (
              <Pressable
                style={({ pressed }) => [{ marginTop: space.lg }, pressed && { opacity: 0.85 }]}
                onPress={() => router.push("/(tabs)/goals" as never)}
              >
                <View style={styles.eyebrowRow}>
                  <Text style={styles.eyebrow}>Goals</Text>
                  <Text style={styles.eyebrowAction}>See all →</Text>
                </View>
                <View style={styles.goalList}>
                  {goals.map((g) => {
                    const saved = Number(g.savedAmount);
                    const target = Number(g.targetAmount);
                    const gpct = target > 0 ? Math.min(100, (saved / target) * 100) : 0;
                    const due = new Date(`${g.dueDate}T12:00:00Z`);
                    const daysLeft = Math.max(
                      0,
                      Math.ceil((due.getTime() - Date.now()) / 86_400_000),
                    );
                    return (
                      <View key={g.id} style={styles.goalRow}>
                        <View style={styles.goalGlyph}>
                          <Ionicons name="flag-outline" size={16} color={colors.primary} />
                        </View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <View style={styles.goalTitleLine}>
                            <Text style={styles.goalTitle} numberOfLines={1}>{g.title}</Text>
                            <Text style={styles.goalAmount}>
                              {formatMoney(g.savedAmount, CURRENCY).display} / {formatMoney(g.targetAmount, CURRENCY).display}
                            </Text>
                          </View>
                          <View style={styles.goalBarTrack}>
                            <View style={[styles.goalBarFill, { width: `${gpct}%` }]} />
                          </View>
                          <Text style={styles.goalMeta}>
                            {gpct.toFixed(0)}% saved · {daysLeft} day{daysLeft === 1 ? "" : "s"} left
                          </Text>
                        </View>
                      </View>
                    );
                  })}
                </View>
              </Pressable>
            )}

            {/* 5. Glance — Income + Net (from /analysis endpoint).
                Hide on fresh accounts with no transactions this month. */}
            {analysis && (analysis.income !== 0 || analysis.net !== 0) && (
              <Pressable
                style={({ pressed }) => [{ marginTop: space.lg }, pressed && { opacity: 0.85 }]}
                onPress={() => router.push("/analysis" as never)}
              >
                <View style={styles.eyebrowRow}>
                  <Text style={styles.eyebrow}>This month</Text>
                  <Text style={styles.eyebrowAction}>See analysis →</Text>
                </View>
                <View style={styles.glanceGrid}>
                  <View style={styles.glanceCard}>
                    <Text style={styles.glanceLabel}>Income</Text>
                    <Text
                      style={[styles.glanceValue, { color: colors.up }]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.6}
                    >
                      {analysis.income > 0
                        ? `+${formatMoney(analysis.income.toFixed(2), CURRENCY).display}`
                        : formatMoney("0.00", CURRENCY).display}
                    </Text>
                  </View>
                  <View style={styles.glanceCard}>
                    <Text style={styles.glanceLabel}>Net</Text>
                    <Text
                      style={[
                        styles.glanceValue,
                        analysis.net < 0 && { color: colors.down },
                        analysis.net > 0 && { color: colors.up },
                      ]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.6}
                    >
                      {analysis.net >= 0 ? "+" : "−"}
                      {formatMoney(Math.abs(analysis.net).toFixed(2), CURRENCY).display}
                    </Text>
                    {analysis.prevNet !== null && (
                      <Text style={styles.glanceTrend}>
                        vs {analysis.prevNet >= 0 ? "+" : "−"}
                        {formatMoney(Math.abs(analysis.prevNet).toFixed(2), CURRENCY).display} last month
                      </Text>
                    )}
                  </View>
                </View>
              </Pressable>
            )}

            {/* 6. Top categories */}
            {topCategories.length > 0 && (
              <>
                <View style={[styles.eyebrowRow, { marginTop: space.lg }]}>
                  <Text style={styles.eyebrow}>Top categories</Text>
                  <Pressable onPress={() => router.push("/budget" as never)}>
                    <Text style={styles.eyebrowAction}>See budget →</Text>
                  </Pressable>
                </View>
                <View style={styles.catList}>
                  {topCategories.map((c) => {
                    const cat = categories[c.categoryId];
                    const meta = categoryMeta(cat);
                    const spent = Number(c.spent);
                    const catCap = planAllocByCat.get(c.categoryId) ?? null;
                    const catPct =
                      catCap && catCap > 0
                        ? Math.min(999, (spent / catCap) * 100)
                        : 0;
                    const catOver = catPct > 100;
                    const name =
                      cat?.name ?? c.categoryName ?? "Uncategorized";
                    return (
                      <Pressable
                        key={c.categoryId}
                        style={({ pressed }) => [
                          styles.catRow,
                          pressed && { opacity: 0.7 },
                        ]}
                        onPress={() => router.push("/budget" as never)}
                      >
                        <View style={[styles.catGlyph, { backgroundColor: meta.bg }]}>
                          <Ionicons name={meta.icon} size={16} color={meta.fg} />
                        </View>
                        <View style={styles.catBody}>
                          <View style={styles.catTopLine}>
                            <Text style={styles.catName} numberOfLines={1}>
                              {name}
                            </Text>
                            <Text
                              style={[
                                styles.catAmount,
                                catOver && { color: colors.down },
                              ]}
                            >
                              {formatMoney(spent.toFixed(2), CURRENCY).display}
                            </Text>
                          </View>
                          {catCap !== null && catCap > 0 && (
                            <>
                              <View style={styles.catBarTrack}>
                                <View
                                  style={[
                                    styles.catBarFill,
                                    {
                                      width: `${Math.min(100, catPct)}%`,
                                      backgroundColor: catOver
                                        ? colors.down
                                        : colors.primary,
                                    },
                                  ]}
                                />
                              </View>
                              <View style={styles.catMetaLine}>
                                <Text style={styles.catMetaText}>
                                  {Math.round(catPct)}% of{" "}
                                  {formatMoney(catCap.toFixed(2), CURRENCY).display}
                                </Text>
                                {catOver && (
                                  <Text style={styles.catMetaOver}>Over</Text>
                                )}
                              </View>
                            </>
                          )}
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            )}

            {/* 7. Recent activity */}
            {recentTxs && recentTxs.length > 0 && (
              <>
                <View style={[styles.eyebrowRow, { marginTop: space.lg }]}>
                  <Text style={styles.eyebrow}>Recent activity</Text>
                  <Pressable onPress={() => router.push("/(tabs)/activity" as never)}>
                    <Text style={styles.eyebrowAction}>See all →</Text>
                  </Pressable>
                </View>
                <View>
                  {recentTxs.map((tx) => {
                    const firstAlloc = tx.allocations[0];
                    const firstAllocCat = firstAlloc?.categoryId
                      ? categories[firstAlloc.categoryId]
                      : null;
                    const isSplit = tx.allocations.length > 1;
                    const merchant =
                      tx.merchantNormalized || tx.merchantRaw || "—";
                    const categoryLabel = isSplit
                      ? "Split"
                      : firstAllocCat?.name ?? "Uncategorized";
                    const meta = categoryMeta(firstAllocCat);
                    const money = formatMoney(tx.amount, tx.currency);
                    return (
                      <Pressable
                        key={tx.id}
                        style={({ pressed }) => [
                          styles.txRow,
                          pressed && { opacity: 0.6 },
                        ]}
                        onPress={() =>
                          router.push(`/transactions/${tx.id}` as never)
                        }
                      >
                        <View style={[styles.txGlyph, { backgroundColor: meta.bg }]}>
                          <Ionicons name={meta.icon} size={18} color={meta.fg} />
                        </View>
                        <View style={styles.txMid}>
                          <View style={styles.txTitleLine}>
                            <Text
                              style={styles.txTitle}
                              numberOfLines={1}
                              ellipsizeMode="tail"
                            >
                              {merchant}
                            </Text>
                            {tx.pending && (
                              <View style={styles.pendingBadge}>
                                <Text style={styles.pendingText}>Pending</Text>
                              </View>
                            )}
                          </View>
                          <Text style={styles.txMeta} numberOfLines={1}>
                            {categoryLabel}
                          </Text>
                        </View>
                        <View style={styles.txRight}>
                          <Text
                            style={[
                              styles.txAmount,
                              money.isIncome && { color: colors.up },
                            ]}
                          >
                            {money.isIncome ? "+" : "−"}
                            {money.display}
                          </Text>
                          <Text style={styles.txTime}>
                            {formatTime(tx.occurredAt)}
                          </Text>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              </>
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
  trialBannerWrap: { marginBottom: space.lg },
  trialBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(143, 184, 232, 0.18)",
    paddingHorizontal: space.base,
    paddingVertical: space.sm,
    borderRadius: 999,
    alignSelf: "flex-start",
  },
  trialBannerText: { ...type$.captionStrong, color: colors.navy },
  trialRevertText: { ...type$.bodySm, color: colors.muted, marginTop: 6, marginLeft: 2 },
  errCard: {
    backgroundColor: colors.surfaceSoft,
    padding: space.base,
    borderRadius: 14,
    marginVertical: space.base,
  },
  errTitle: { ...type$.titleSm, color: colors.down, marginBottom: 4 },
  errBody: { ...type$.bodySm, color: colors.body },
  retryBtn: {
    marginTop: space.sm,
    paddingHorizontal: space.base,
    paddingVertical: space.sm,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignSelf: "flex-start",
  },
  retryBtnText: { ...type$.bodySm, color: colors.onPrimary, fontWeight: "600" },

  // ── Hero ──────────────────────────────────────────────
  hero: {
    paddingVertical: space.sm,
    marginBottom: space.base,
  },
  heroLabel: {
    ...type$.captionStrong,
    color: colors.muted,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  heroValue: {
    fontSize: 40,
    lineHeight: 44,
    fontWeight: "500",
    letterSpacing: -0.8,
    color: colors.ink,
    fontVariant: ["tabular-nums"],
  },
  heroValueDecimal: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: "500",
    color: colors.muted,
  },
  heroMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 6,
    flexWrap: "wrap",
  },
  heroMetaText: { ...type$.bodySm, color: colors.muted },
  heroMetaTextStrong: { ...type$.bodySm, fontWeight: "600" },
  heroMetaDot: {
    width: 3,
    height: 3,
    borderRadius: 999,
    backgroundColor: colors.mutedSoft,
  },
  heroCta: { ...type$.captionStrong, color: colors.primary, marginTop: 6 },
  heroBarTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceSoft,
    marginTop: space.base,
    overflow: "hidden",
  },
  heroBarFill: { height: 6, borderRadius: 3 },
  heroAxis: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 6,
  },
  heroAxisText: { ...type$.caption, color: colors.muted, fontVariant: ["tabular-nums"] },
  heroAxisDot: { ...type$.caption, color: colors.mutedSoft },

  // ── Brief card ────────────────────────────────────────
  briefCard: {
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 16,
    padding: space.base,
    marginBottom: space.base,
  },
  briefHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  briefEyebrow: { flexDirection: "row", alignItems: "center", gap: 6 },
  briefDot: {
    width: 6,
    height: 6,
    borderRadius: 999,
    backgroundColor: colors.mint,
  },
  briefEyebrowText: {
    ...type$.captionStrong,
    color: colors.body,
    textTransform: "none",
  },
  briefTime: { ...type$.caption, color: colors.muted },
  briefBody: {
    ...type$.bodyMd,
    color: colors.body,
    marginTop: space.sm,
  },
  briefFoot: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: space.sm,
  },
  briefMeta: { ...type$.captionStrong, color: colors.accentYellow },
  briefCta: { flexDirection: "row", alignItems: "center", gap: 2 },
  briefCtaText: { ...type$.captionStrong, color: colors.primary },

  // ── Goals summary ─────────────────────────────────────
  goalList: { gap: space.sm },
  goalRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 12,
  },
  goalGlyph: {
    width: 32,
    height: 32,
    borderRadius: 999,
    backgroundColor: "rgba(62, 179, 139, 0.16)",
    alignItems: "center",
    justifyContent: "center",
  },
  goalTitleLine: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  goalTitle: {
    ...type$.bodyMd,
    color: colors.ink,
    fontWeight: "600",
    flex: 1,
  },
  goalAmount: {
    ...type$.caption,
    color: colors.muted,
    fontVariant: ["tabular-nums"],
  },
  goalBarTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.surfaceStrong,
    marginTop: 6,
    overflow: "hidden",
  },
  goalBarFill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.primary,
  },
  goalMeta: {
    ...type$.caption,
    color: colors.muted,
    marginTop: 4,
  },

  // ── Section eyebrows ──────────────────────────────────
  eyebrow: {
    ...type$.captionStrong,
    color: colors.muted,
    textTransform: "uppercase",
    marginBottom: space.sm,
  },
  eyebrowRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
  },
  eyebrowAction: {
    ...type$.captionStrong,
    color: colors.primary,
    textTransform: "none",
  },

  // ── Glance grid ───────────────────────────────────────
  glanceGrid: {
    flexDirection: "row",
    gap: space.sm,
    marginBottom: space.sm,
  },
  glanceCard: {
    flex: 1,
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 16,
    padding: space.base,
  },
  glanceLabel: { ...type$.captionStrong, color: colors.muted, textTransform: "uppercase" },
  glanceValue: {
    ...type$.titleMd,
    color: colors.ink,
    marginTop: 4,
    fontVariant: ["tabular-nums"],
  },
  glanceTrend: { ...type$.caption, color: colors.muted, marginTop: 4 },

  // ── Category rows ─────────────────────────────────────
  catList: { gap: 4 },
  catRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    paddingVertical: 10,
  },
  catGlyph: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  catBody: { flex: 1, minWidth: 0 },
  catTopLine: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  catName: { ...type$.titleSm, color: colors.ink, flex: 1 },
  catAmount: {
    ...type$.bodyMd,
    color: colors.ink,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  catBarTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.surfaceSoft,
    marginTop: 6,
    overflow: "hidden",
  },
  catBarFill: { height: 4, borderRadius: 2 },
  catMetaLine: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 4,
  },
  catMetaText: { ...type$.caption, color: colors.muted, fontVariant: ["tabular-nums"] },
  catMetaOver: { ...type$.captionStrong, color: colors.down },

  // ── Transaction rows ──────────────────────────────────
  txRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    paddingVertical: 10,
  },
  txGlyph: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  txMid: { flex: 1, minWidth: 0 },
  txTitleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
  },
  txTitle: { ...type$.titleSm, color: colors.ink, flexShrink: 1, flex: 1 },
  txMeta: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  pendingBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 999,
  },
  pendingText: { ...type$.captionStrong, color: colors.muted, fontSize: 10 },
  txRight: { alignItems: "flex-end" },
  txAmount: {
    ...type$.bodyMd,
    color: colors.ink,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  txTime: {
    ...type$.caption,
    color: colors.muted,
    marginTop: 2,
    fontVariant: ["tabular-nums"],
  },
});
