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
  type MeDTO as Me,
  type CategoryDTO,
  type TransactionDTO,
  type ChatThreadDTO,
} from "@fina/shared";
import { useSession } from "../../src/auth/client";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { useCollapsingHeader } from "../../src/design/useCollapsingHeader";
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

type Schedule = {
  id: string;
  amount: string;
  scheduledDate: string;
  status: string;
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
  const [scheduleSummary, setScheduleSummary] = useState<{
    count: number;
    total: number;
    nextDate: string | null;
  } | null>(null);

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
          })
          .catch(() => setLatestUnboundThread(null)),
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
        apiFetch<{ schedules: Schedule[] }>(
          `/workspaces/${wsId}/schedules?status=upcoming`,
        )
          .then((r) => {
            const count = r.schedules.length;
            const total = r.schedules.reduce((s, x) => s + Number(x.amount), 0);
            const nextDate =
              r.schedules
                .map((s) => s.scheduledDate)
                .sort()[0] ?? null;
            setScheduleSummary({ count, total, nextDate });
          })
          .catch(() => setScheduleSummary(null)),
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

  // ── Schedule deep-link copy ────────────────────────────────
  const scheduleMeta = scheduleSummary
    ? (() => {
        const parts = [
          `${scheduleSummary.count} scheduled`,
        ];
        if (scheduleSummary.nextDate) {
          const d = new Date(`${scheduleSummary.nextDate}T12:00:00Z`);
          if (!Number.isNaN(d.getTime())) {
            parts.push(`next ${formatMonthDay(d)}`);
          }
        }
        return parts.join(" · ");
      })()
    : null;

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
            {/* 2. Hero — month spending */}
            {budgetCurrent && (
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

            {/* 3. Brief card — deep-link to chat */}
            {latestUnboundThread && (
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

            {/* 4. Schedule deep-link */}
            {scheduleSummary && scheduleSummary.count > 0 && (
              <Pressable
                style={({ pressed }) => [styles.scheduleRow, pressed && { opacity: 0.7 }]}
                onPress={() => router.push("/scheduled" as never)}
                accessibilityLabel="View schedule"
              >
                <View style={styles.scheduleGlyph}>
                  <Ionicons name="calendar" size={16} color={colors.primary} />
                </View>
                <View style={styles.scheduleBody}>
                  <View style={styles.scheduleTitleLine}>
                    <Text style={styles.scheduleTitle}>Upcoming this month</Text>
                    <Text style={styles.scheduleAmount}>
                      −{formatMoney(scheduleSummary.total.toFixed(2), CURRENCY).display}
                    </Text>
                  </View>
                  {scheduleMeta && (
                    <Text style={styles.scheduleMeta} numberOfLines={1}>
                      {scheduleMeta}
                    </Text>
                  )}
                </View>
                <Ionicons name="chevron-forward" size={14} color={colors.mutedSoft} />
              </Pressable>
            )}

            {/* 5. Glance (Spent/Income) — deferred to v2: Hero already shows
                month spend; Spent-only glance was visually duplicative until
                an income aggregate endpoint exists. */}

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
  trialBannerText: { ...type$.captionStrong, color: colors.navy },
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

  // ── Schedule deep-link ────────────────────────────────
  scheduleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 12,
    marginBottom: space.base,
  },
  scheduleGlyph: {
    width: 28,
    height: 28,
    borderRadius: 999,
    backgroundColor: "rgba(62, 179, 139, 0.16)",
    alignItems: "center",
    justifyContent: "center",
  },
  scheduleBody: { flex: 1, minWidth: 0 },
  scheduleTitleLine: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  scheduleTitle: { ...type$.bodySm, color: colors.body, flex: 1 },
  scheduleAmount: {
    ...type$.bodySm,
    color: colors.ink,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  scheduleMeta: { ...type$.caption, color: colors.muted, marginTop: 2 },

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
    ...type$.titleLg,
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
