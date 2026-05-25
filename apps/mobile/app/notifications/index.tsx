import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Switch,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type {
  MeDTO as Me,
  NotificationPrefs,
} from "@fina/shared";
import { apiFetch } from "../../src/api/client";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";

type ToggleKey = keyof NotificationPrefs;

type ToggleSpec = {
  key: ToggleKey;
  title: string;
  sub: string;
  /** When true, the toggle persists but no push actually fires yet —
   *  the channel's trigger isn't implemented. Surfaced as a "Coming
   *  soon" pill so the user isn't confused by an inert switch. */
  comingSoon?: boolean;
};

type Section = {
  label: string;
  rows: ToggleSpec[];
};

const SECTIONS: Section[] = [
  {
    label: "Daily",
    rows: [
      {
        key: "morningBrief",
        title: "Morning brief",
        sub: "One push each morning summarizing yesterday.",
      },
    ],
  },
  {
    label: "Worth a look",
    rows: [
      {
        key: "largeCharges",
        title: "Large or unusual charges",
        sub: "When something costs way more than your usual.",
      },
      {
        key: "transactionAdded",
        title: "New transaction added",
        sub: "Every new charge on any workspace you're in. Manual entries skip the person who typed it.",
      },
      {
        key: "goalMilestones",
        title: "Goal milestones",
        sub: "When you cross 25 / 50 / 75% on a goal.",
      },
    ],
  },
  {
    label: "Account",
    rows: [
      {
        key: "bankReconnect",
        title: "Bank reconnect required",
        sub: "When a connected bank stops syncing.",
      },
      {
        key: "trialExpiring",
        title: "Trial expiring",
        sub: "5, 3, and 1 day before your trial ends.",
      },
      {
        key: "workspaceInvites",
        title: "Workspace invites",
        sub: "When someone invites you to a workspace.",
      },
    ],
  },
  {
    label: "Marketing",
    rows: [
      {
        key: "productUpdates",
        title: "Product updates",
        sub: "New features and tips. Sparse.",
      },
    ],
  },
];

export default function NotificationSettings() {
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const m = await apiFetch<Me>("/me");
      setMe(m);
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = useCallback(
    async (key: ToggleKey, next: boolean) => {
      setSaving(true);
      try {
        const m = await apiFetch<Me>("/me", {
          method: "PATCH",
          body: JSON.stringify({ notificationPrefs: { [key]: next } }),
        });
        setMe(m);
      } catch (e) {
        Alert.alert(
          "Couldn't save",
          (e as { code?: string }).code ?? "Try again.",
        );
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  if (!me) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Header />
        <View style={styles.fallback}>
          {err ? (
            <>
              <Text style={styles.errTitle}>Couldn't load</Text>
              <Text style={styles.errBody}>{err}</Text>
              <Pressable style={styles.cta} onPress={load}>
                <Text style={styles.ctaText}>Try again</Text>
              </Pressable>
            </>
          ) : (
            <ActivityIndicator color={colors.primary} />
          )}
        </View>
      </SafeAreaView>
    );
  }

  const prefs = me.user.notificationPrefs;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Header />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.hero}>
          <View style={styles.heroGlyph}>
            <Ionicons name="notifications-outline" size={22} color={colors.primary} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.heroTitle}>Push notifications</Text>
            <Text style={styles.heroSub}>
              Pick what's worth interrupting you for. Everything still shows up
              in chat.
            </Text>
          </View>
        </View>

        {SECTIONS.map((section) => (
          <View key={section.label} style={styles.section}>
            <Text style={styles.groupLabel}>{section.label}</Text>
            <View style={styles.group}>
              {section.rows.map((r, idx) => {
                const briefGated =
                  r.key === "morningBrief" && me.user.pauseEnabled;
                return (
                  <View
                    key={r.key}
                    style={[
                      styles.row,
                      idx > 0 && styles.rowBorder,
                    ]}
                  >
                    <View style={styles.rowBody}>
                      <View style={styles.rowTitleRow}>
                        <Text
                          style={[
                            styles.rowTitle,
                            briefGated && styles.rowTitleMuted,
                          ]}
                        >
                          {r.title}
                        </Text>
                        {r.comingSoon && (
                          <View style={styles.soonPill}>
                            <Text style={styles.soonPillText}>Soon</Text>
                          </View>
                        )}
                      </View>
                      {briefGated ? (
                        <Pressable onPress={() => router.push("/brief" as never)}>
                          <Text style={styles.rowSubLink}>
                            Brief is off. Turn it on in Brief settings.
                          </Text>
                        </Pressable>
                      ) : (
                        <Text style={styles.rowSub}>{r.sub}</Text>
                      )}
                    </View>
                    <Switch
                      value={prefs[r.key] && !briefGated}
                      onValueChange={(v) => toggle(r.key, v)}
                      disabled={saving || briefGated}
                      trackColor={{
                        true: colors.primary,
                        false: colors.surfaceStrong,
                      }}
                    />
                  </View>
                );
              })}
            </View>
          </View>
        ))}

        <Text style={styles.helper}>
          Disabling a channel here stops the push only. The underlying
          event still lands in chat and on the relevant screen.
        </Text>

        {__DEV__ && <DevTestButtons />}
      </ScrollView>
    </SafeAreaView>
  );
}

type TestPushResult = {
  sent: number;
  failed: number;
  deviceCount: number;
  channelEnabled: boolean;
};

function DevTestButtons() {
  const [busy, setBusy] = useState<ToggleKey | null>(null);
  const send = async (channel: ToggleKey) => {
    if (busy) return;
    setBusy(channel);
    try {
      const r = await apiFetch<TestPushResult>("/me/test-push", {
        method: "POST",
        body: JSON.stringify({ channel }),
      });
      // Surface what happened so the user can disambiguate the
      // common failure modes. Push notifications don't work in
      // Expo Go on iOS since SDK 50 — a 0-device send usually
      // means the user is on Expo Go and needs a dev build.
      if (r.sent > 0) {
        Alert.alert("Sent ✓", `Delivered to ${r.sent} device${r.sent === 1 ? "" : "s"}.`);
      } else if (!r.channelEnabled) {
        Alert.alert(
          "Channel is off",
          "Enable this channel in the toggles above before testing.",
        );
      } else if (r.deviceCount === 0) {
        Alert.alert(
          "No device registered",
          "Push notifications need a development build. Expo Go on iOS doesn't receive them since SDK 50. Sign out / sign in once you build a dev client to register a device.",
        );
      } else {
        Alert.alert(
          "All sends failed",
          `${r.failed} device(s) rejected. Check API logs (likely a stale or invalid token).`,
        );
      }
    } catch (e) {
      Alert.alert(
        "Test push failed",
        (e as { code?: string }).code ?? "API request failed.",
      );
    } finally {
      setBusy(null);
    }
  };
  const channels: Array<{ key: ToggleKey; label: string }> = [
    { key: "morningBrief", label: "Morning brief" },
    { key: "bankReconnect", label: "Bank reconnect" },
    { key: "workspaceInvites", label: "Workspace invite" },
    { key: "trialExpiring", label: "Trial expiring" },
    { key: "goalMilestones", label: "Goal milestone" },
    { key: "largeCharges", label: "Large charge" },
    { key: "transactionAdded", label: "Transaction added" },
    { key: "productUpdates", label: "Product update" },
  ];
  return (
    <View style={styles.devSection}>
      <Text style={styles.devLabel}>Dev · test pushes</Text>
      <Text style={styles.devHelp}>
        Fires a sample push of each channel to this device. Disabled
        channels above are still gated server-side.
      </Text>
      <View style={styles.devGrid}>
        {channels.map((c) => (
          <Pressable
            key={c.key}
            onPress={() => send(c.key)}
            disabled={busy !== null}
            style={({ pressed }) => [
              styles.devBtn,
              busy === c.key && { opacity: 0.5 },
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={styles.devBtnText}>{c.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function Header() {
  return (
    <View style={styles.nav}>
      <HeaderIconButton
        icon="chevron-back"
        accessibilityLabel="Back"
        onPress={() => router.back()}
        variant="plain"
      />
      <Text style={styles.navTitle}>Notifications</Text>
      <View style={{ width: 34 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  nav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.base,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  navTitle: { ...type$.titleSm, color: colors.ink, fontWeight: "600" },

  scroll: { padding: space.lg, paddingBottom: space.xl },
  fallback: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
  errTitle: { ...type$.titleMd, color: colors.down, marginBottom: 4 },
  errBody: { ...type$.bodyMd, color: colors.body, marginBottom: space.base },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm + 2,
    borderRadius: 999,
  },
  ctaText: { ...type$.bodyMd, color: colors.onPrimary, fontWeight: "600" },

  hero: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.base,
    backgroundColor: "rgba(62, 179, 139, 0.10)",
    borderRadius: 16,
    padding: space.base,
    marginBottom: space.lg,
  },
  heroGlyph: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: "rgba(62, 179, 139, 0.16)",
    alignItems: "center",
    justifyContent: "center",
  },
  heroTitle: { ...type$.titleSm, color: colors.ink, fontWeight: "600" },
  heroSub: { ...type$.bodySm, color: colors.body, marginTop: 2 },

  section: { marginBottom: space.base },
  groupLabel: {
    ...type$.captionStrong,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: space.sm,
    marginTop: space.base,
  },
  group: {
    backgroundColor: colors.canvas,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.hairlineSoft,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.base,
    paddingHorizontal: space.base,
  },
  rowBorder: {
    borderTopWidth: 1,
    borderTopColor: colors.hairlineSoft,
  },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  rowTitle: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  rowTitleMuted: { color: colors.muted },
  rowSub: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  rowSubLink: {
    ...type$.bodySm,
    color: colors.primary,
    marginTop: 2,
    textDecorationLine: "underline",
  },
  soonPill: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
  },
  soonPillText: {
    ...type$.caption,
    color: colors.muted,
    fontWeight: "600",
    letterSpacing: 0.4,
  },

  helper: {
    ...type$.bodySm,
    color: colors.muted,
    textAlign: "center",
    marginTop: space.lg,
    paddingHorizontal: space.lg,
  },

  // Dev-only section — wrapped in __DEV__ on render, but styled here
  // so the production bundle still tree-shakes the JSX out cleanly.
  devSection: {
    marginTop: space.xl,
    padding: space.base,
    borderRadius: 14,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.hairline,
    backgroundColor: colors.surfaceSoft,
  },
  devLabel: {
    ...type$.captionStrong,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  devHelp: {
    ...type$.bodySm,
    color: colors.muted,
    marginBottom: space.sm,
  },
  devGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  devBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  devBtnText: { ...type$.bodySm, color: colors.ink, fontWeight: "600" },
});
