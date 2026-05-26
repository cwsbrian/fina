import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  Alert,
  ActivityIndicator,
  Animated,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCollapsingHeader } from "../../src/design/useCollapsingHeader";

const HEADER_HEIGHT = 84;
import { router, useFocusEffect } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import {
  displayName,
  localPartOfEmail,
  initials,
  tierLabel,
  trialDaysLeft,
  type BankAccountDTO,
  type MeDTO as Me,
} from "@fina/shared";
import { useSession, signOut } from "../../src/auth/client";
import { unregisterForPushNotifications } from "../../src/api/push";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import {
  getActiveWorkspaceId,
  clearActiveWorkspaceId,
} from "../../src/workspace/active";
import { ONBOARDING_SEEN_KEY } from "../../src/onboarding/storage";
import { colors, space, type as type$ } from "../../src/design/tokens";

type PlaidItemSummary = {
  status: string;
  errorCode: string | null;
};

type ActiveWorkspace = {
  id: string;
  name: string;
  role: "owner" | "editor" | "viewer";
};

export default function More() {
  const { data: session } = useSession();
  const [me, setMe] = useState<Me | null>(null);
  const [activeWs, setActiveWs] = useState<ActiveWorkspace | null>(null);
  const [banks, setBanks] = useState<PlaidItemSummary[] | null>(null);
  const [openingBilling, setOpeningBilling] = useState(false);
  const [needsReviewCount, setNeedsReviewCount] = useState(0);

  const loadMe = useCallback(() => {
    apiFetch<Me>("/me").then(setMe).catch(() => {});
  }, []);

  const loadActiveWorkspace = useCallback(async () => {
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) return;
      const list = await apiFetch<{
        workspaces: Array<{
          id: string;
          name: string;
          role: "owner" | "editor" | "viewer";
        }>;
      }>("/workspaces");
      const match = list.workspaces.find((w) => w.id === wsId);
      if (match) setActiveWs(match);
    } catch {
      // Non-fatal — card falls back to a generic label.
    }
  }, []);

  const loadBanks = useCallback(async () => {
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) return;
      const data = await apiFetch<{ plaidItems: PlaidItemSummary[] }>(
        `/workspaces/${wsId}/plaid-items`,
      );
      setBanks(data.plaidItems);
    } catch {
      // Non-fatal — banks subtitle just renders a dash.
    }
  }, []);

  const loadNeedsReview = useCallback(async () => {
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) return;
      const r = await apiFetch<{ transactions: unknown[] }>(
        `/workspaces/${wsId}/transactions?needsReview=true&limit=50`,
      );
      setNeedsReviewCount(r.transactions.length);
    } catch {
      // Non-fatal — Review queue row falls back to no count.
    }
  }, []);

  useEffect(() => {
    loadMe();
    loadActiveWorkspace();
    loadBanks();
    loadNeedsReview();
  }, [loadMe, loadActiveWorkspace, loadBanks, loadNeedsReview]);

  // Refresh on focus so a bank disconnected / billing portal change shows fresh.
  useFocusEffect(
    useCallback(() => {
      loadMe();
      loadActiveWorkspace();
      loadBanks();
      loadNeedsReview();
    }, [loadMe, loadActiveWorkspace, loadBanks, loadNeedsReview]),
  );

  const onSignOut = () => {
    Alert.alert("Sign out", "Sign out of Fina?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: async () => {
          await unregisterForPushNotifications();
          await signOut();
          router.replace("/" as never);
        },
      },
    ]);
  };

  const onManageBilling = async () => {
    if (openingBilling) return;
    setOpeningBilling(true);
    try {
      const resp = await apiFetch<{ url: string }>("/billing/portal", {
        method: "POST",
      });
      await WebBrowser.openBrowserAsync(resp.url);
    } catch (e) {
      const code = (e as { code?: string }).code ?? "error";
      Alert.alert(
        "Couldn't open billing",
        code === "portal_failed"
          ? "Set up a subscription first to manage billing."
          : `Try again (${code}).`,
      );
    } finally {
      setOpeningBilling(false);
    }
  };

  const comingSoon = (label: string) => () =>
    Alert.alert("Coming soon", `${label} screen is on the way.`);

  const days = me?.trial?.endsAt ? trialDaysLeft(me.trial.endsAt) : null;
  const bankSubtitle = banks
    ? banks.length === 0
      ? "Connect to start importing"
      : `${banks.length} connected${
          banks.some((b) => b.status === "error" || b.errorCode)
            ? " · needs attention"
            : ""
        }`
    : "—";

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
        {/* Profile card */}
        {me && (
          <Pressable
            style={({ pressed }) => [styles.profileCard, pressed && { opacity: 0.7 }]}
            onPress={() => router.push("/profile/edit" as never)}
          >
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {initials(me.user.name, me.user.email)}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.profileName} numberOfLines={1}>
                {me.user.name?.trim() || localPartOfEmail(me.user.email)}
              </Text>
              <Text style={styles.profileEmail}>{me.user.email}</Text>
              <View style={styles.pill}>
                <Text style={styles.pillText}>
                  {tierLabel(me.tier, me.trial.active)}
                  {me.trial.active && days !== null ? ` · ${days}d` : ""}
                </Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.mutedSoft} />
          </Pressable>
        )}

        {/* Workspace */}
        <GroupLabel>Workspace</GroupLabel>
        <Pressable
          style={({ pressed }) => [
            styles.wsCard,
            pressed && { backgroundColor: colors.surfaceSoft },
          ]}
          onPress={() => router.push("/workspace/switch" as never)}
        >
          <View style={styles.wsMark}>
            <Text style={styles.wsMarkText}>
              {activeWs
                ? (activeWs.name.trim()[0]?.toUpperCase() ?? "W")
                : me
                  ? initials(me.user.name, me.user.email)[0]
                  : "F"}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.wsName} numberOfLines={1}>
              {activeWs
                ? activeWs.name
                : me?.user.name
                  ? `${me.user.name}'s workspace`
                  : "Personal workspace"}
            </Text>
            <Text style={styles.wsMeta}>
              {activeWs
                ? activeWs.role === "owner"
                  ? "Owner"
                  : activeWs.role === "editor"
                    ? "Editor"
                    : "Viewer"
                : "Owner"}
            </Text>
          </View>
          <Ionicons name="chevron-down" size={14} color={colors.muted} />
        </Pressable>
        <View style={styles.wsActions}>
          <Pressable
            style={({ pressed }) => [
              styles.wsAction,
              pressed && { opacity: 0.6 },
            ]}
            onPress={() => router.push("/workspace" as never)}
          >
            <Ionicons name="person-outline" size={14} color={colors.body} />
            <Text style={styles.wsActionText}>Manage members</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.wsAction,
              pressed && { opacity: 0.6 },
            ]}
            onPress={() => router.push("/workspace/new" as never)}
          >
            <Ionicons name="add" size={16} color={colors.body} />
            <Text style={styles.wsActionText}>New workspace</Text>
          </Pressable>
        </View>

        {/* Planning */}
        <GroupLabel>Planning</GroupLabel>
        <Group>
          <SettingsRow
            icon="calendar-outline"
            title="Scheduled"
            subtitle="Upcoming planned spends"
            onPress={() => router.push("/scheduled" as never)}
          />
          <SettingsRow
            icon="repeat-outline"
            title="Subscriptions"
            subtitle="Monthly recurring services"
            onPress={() => router.push("/subscriptions" as never)}
          />
          <SettingsRow
            icon="trending-down-outline"
            title="Budget"
            subtitle="Monthly cap + category split"
            onPress={() => router.push("/budget" as never)}
            last
          />
        </Group>

        {/* Insights */}
        <GroupLabel>Insights</GroupLabel>
        <Group>
          <SettingsRow
            icon="bar-chart-outline"
            title="Analysis"
            subtitle="Patterns, trends, category breakdown"
            onPress={() => router.push("/analysis" as never)}
          />
          <SettingsRow
            icon="list-outline"
            title="Review queue"
            detail={reviewQueueDetail(needsReviewCount)}
            onPress={() => router.push("/categorize/inbox" as never)}
            last
          />
        </Group>

        {/* Connections */}
        <GroupLabel>Connections</GroupLabel>
        <Group>
          <SettingsRow
            icon="card-outline"
            title="Banks"
            subtitle={bankSubtitle}
            warn={
              banks ? banks.some((b) => b.status === "error" || b.errorCode) : false
            }
            onPress={() => router.push("/banks" as never)}
            last
          />
        </Group>

        {/* AI */}
        <GroupLabel>AI</GroupLabel>
        <Group>
          <SettingsRow
            icon="sunny-outline"
            title="Morning brief"
            subtitle={briefSubtitle(me)}
            onPress={() => router.push("/brief" as never)}
          />
          <SettingsRow
            icon="notifications-outline"
            title="Notifications"
            detail={notificationsDetail(me)}
            onPress={() => router.push("/notifications" as never)}
          />
          <SettingsRow
            icon="construct-outline"
            title="Categorization style"
            detail={modeLabel(me)}
            onPress={() => router.push("/categorization" as never)}
            last
          />
        </Group>

        {/* Subscription */}
        <GroupLabel>Subscription</GroupLabel>
        <Group>
          <SettingsRow
            icon="star-outline"
            title="Plan"
            detail={me ? tierLabel(me.tier, me.trial.active) : "—"}
            onPress={comingSoon("Plan")}
          />
          <SettingsRow
            icon="card-outline"
            title="Manage billing"
            detail={
              openingBilling ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : undefined
            }
            onPress={onManageBilling}
            last
          />
        </Group>

        {/* Account */}
        <GroupLabel>Account</GroupLabel>
        <Group>
          <SettingsRow
            icon="person-outline"
            title="Edit profile"
            onPress={() => router.push("/profile/edit" as never)}
          />
          <SettingsRow
            icon="download-outline"
            title="Export data"
            onPress={comingSoon("Export")}
          />
          <SettingsRow
            icon="log-out-outline"
            title="Sign out"
            onPress={onSignOut}
          />
          <SettingsRow
            icon="trash-outline"
            title="Delete account"
            danger
            onPress={comingSoon("Delete account")}
            last
          />
        </Group>

        {__DEV__ && (
          <Pressable
            style={[styles.devBtn]}
            onPress={async () => {
              await unregisterForPushNotifications();
              await signOut();
              await AsyncStorage.removeItem(ONBOARDING_SEEN_KEY);
              await clearActiveWorkspaceId();
              router.replace("/" as never);
            }}
          >
            <Text style={styles.devBtnText}>
              DEV · Reset (clear onboarding + sign out)
            </Text>
          </Pressable>
        )}

        {session?.user?.id && (
          <Text style={styles.versionLine}>
            Signed in as {session.user.email}
          </Text>
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
            <Text style={styles.title}>More</Text>
            <Text style={styles.subtitle}>Profile, workspace &amp; settings</Text>
          </View>
        </View>
      </Animated.View>
      <View style={[styles.statusBarBg, { height: insets.top }]} />
    </View>
  );
}

function modeLabel(me: Me | null): string {
  if (!me) return "—";
  switch (me.user.categorizationMode) {
    case "strict":   return "Strict";
    case "flexible": return "Flexible";
    case "auto":     return "Auto";
  }
}

function reviewQueueDetail(n: number): string {
  if (n === 0) return "0";
  if (n >= 50) return "50+";
  return String(n);
}

function notificationsDetail(me: Me | null): string {
  if (!me?.user.notificationPrefs) return "—";
  const prefs = me.user.notificationPrefs;
  const keys = Object.keys(prefs) as Array<keyof typeof prefs>;
  const on = keys.filter((k) => prefs[k]).length;
  if (on === 0) return "All off";
  if (on === keys.length) return "All on";
  return `${on} on`;
}

function briefSubtitle(me: Me | null): string {
  if (!me) return "Daily summary time and pause";
  const hhmm = me.user.morningTime ?? "08:00";
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr) || 8;
  const m = Number(mStr) || 0;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const timeLabel = `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
  if (me.user.pauseEnabled) return "Off";
  if (
    me.user.snoozeUntil &&
    new Date(me.user.snoozeUntil).getTime() > Date.now()
  ) {
    const d = new Date(me.user.snoozeUntil);
    const dateLabel = d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    return `Paused until ${dateLabel}`;
  }
  return `On · ${timeLabel}`;
}

function GroupLabel({ children }: { children: ReactNode }) {
  return <Text style={styles.groupLabel}>{children}</Text>;
}

function Group({ children }: { children: ReactNode }) {
  return <View style={styles.group}>{children}</View>;
}

function SettingsRow({
  icon,
  title,
  subtitle,
  detail,
  warn,
  danger,
  last,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  detail?: ReactNode;
  warn?: boolean;
  danger?: boolean;
  last?: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        !last && styles.rowBorder,
        pressed && { backgroundColor: colors.surfaceSoft },
      ]}
      onPress={onPress}
    >
      <View style={styles.rowGlyph}>
        <Ionicons
          name={icon}
          size={18}
          color={danger ? colors.down : colors.body}
        />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.rowTitle, danger && { color: colors.down }]}>
          {title}
        </Text>
        {subtitle && (
          <Text style={[styles.rowSub, warn && { color: colors.down }]}>
            {subtitle}
          </Text>
        )}
      </View>
      {detail && (
        <View style={styles.rowDetail}>
          {typeof detail === "string" ? (
            <Text style={styles.rowDetailText}>{detail}</Text>
          ) : (
            detail
          )}
        </View>
      )}
      {onPress && (
        <Ionicons name="chevron-forward" size={16} color={colors.mutedSoft} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
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
  safe: { flex: 1, backgroundColor: colors.canvas },
  scroll: { padding: space.lg, paddingBottom: space.xxl },
  title: { ...type$.titleLg, color: colors.ink },
  subtitle: { ...type$.bodySm, color: colors.muted, marginTop: 2 },

  // Profile card
  profileCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 16,
    padding: space.base,
    gap: space.base,
    marginBottom: space.base,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 999,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: colors.onDark, fontSize: 18, fontWeight: "600" },
  profileName: { ...type$.titleSm, color: colors.ink },
  profileEmail: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  pill: {
    alignSelf: "flex-start",
    marginTop: 8,
    backgroundColor: colors.surfaceSoft,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  pillText: { ...type$.captionStrong, color: colors.body },

  // Section label
  groupLabel: {
    ...type$.bodySm,
    color: colors.muted,
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    paddingHorizontal: space.xs,
    paddingTop: space.base,
    paddingBottom: space.xs,
  },

  // Workspace card
  wsCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 16,
    padding: space.base,
  },
  wsMark: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  wsMarkText: { ...type$.titleSm, color: colors.onDark },
  wsName: { ...type$.titleSm, color: colors.ink },
  wsMeta: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  wsActions: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 4,
    marginTop: 8,
  },
  wsAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 999,
  },
  wsActionText: { ...type$.bodySm, color: colors.body, fontWeight: "600" },

  // Settings groups
  group: {
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 16,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    padding: space.base,
    gap: space.sm,
  },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.hairlineSoft },
  rowGlyph: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTitle: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  rowSub: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  rowDetail: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowDetailText: { ...type$.bodyMd, color: colors.muted },

  // Dev / footer
  devBtn: {
    marginTop: space.lg,
    padding: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.accentYellow,
    borderStyle: "dashed",
    alignItems: "center",
  },
  devBtnText: { ...type$.bodySm, color: colors.body },
  versionLine: {
    ...type$.bodySm,
    color: colors.mutedSoft,
    textAlign: "center",
    marginTop: space.lg,
  },
});
