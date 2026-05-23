import { useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable, ScrollView, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import {
  displayName,
  initials,
  tierLabel,
  trialDaysLeft,
  type MeDTO as Me,
} from "@fina/shared";
import { useSession, signOut } from "../../src/auth/client";
import { unregisterForPushNotifications } from "../../src/api/push";
import { apiFetch } from "../../src/api/client";
import { ONBOARDING_SEEN_KEY } from "../../src/onboarding/storage";
import { clearActiveWorkspaceId } from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";

type Row = {
  id: string;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  // Placeholder onPress — most drill-ins land in later phases.
  onPress?: () => void;
};

export default function More() {
  const { data: session } = useSession();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    apiFetch<Me>("/me").then(setMe).catch(() => {});
  }, []);

  const rows: Row[] = [
    {
      id: "subscription",
      icon: "star-outline",
      title: "Subscription",
      subtitle: me ? tierLabel(me.tier, me.trial.active) : "—",
      onPress: () => Alert.alert("Coming soon", "Subscription screen lands in Phase 5."),
    },
    {
      id: "banks",
      icon: "card-outline",
      title: "Banks",
      subtitle: "Connect and manage Plaid links",
      onPress: () => router.push("/banks" as never),
    },
    {
      id: "workspace",
      icon: "people-outline",
      title: "Workspace",
      subtitle: "Members, invites, role",
      onPress: () => Alert.alert("Coming soon", "Workspace screen lands in Phase 5."),
    },
    {
      id: "notifications",
      icon: "notifications-outline",
      title: "Notifications",
      subtitle: "Morning brief, anomaly alerts",
      onPress: () => Alert.alert("Coming soon", "Notifications screen lands in Phase 5."),
    },
    {
      id: "profile",
      icon: "person-outline",
      title: "Edit profile",
      onPress: () => Alert.alert("Coming soon", "Profile screen lands in Phase 5."),
    },
  ];

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

  const days = me?.trial?.endsAt ? trialDaysLeft(me.trial.endsAt) : null;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>More</Text>

        {me && (
          <View style={styles.profileCard}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {initials(me.user.name, me.user.email)}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.profileName}>
                {displayName({ name: me.user.name, email: me.user.email })}
              </Text>
              <Text style={styles.profileEmail}>{me.user.email}</Text>
              <View style={styles.pill}>
                <Text style={styles.pillText}>
                  {tierLabel(me.tier, me.trial.active)}
                  {me.trial.active && days !== null
                    ? ` · ${days}d`
                    : ""}
                </Text>
              </View>
            </View>
          </View>
        )}

        <View style={styles.group}>
          {rows.map((r, i) => (
            <Pressable
              key={r.id}
              style={({ pressed }) => [
                styles.row,
                i === 0 && { borderTopWidth: 0 },
                pressed && { backgroundColor: colors.surfaceSoft },
              ]}
              onPress={r.onPress}
            >
              <View style={styles.rowGlyph}>
                <Ionicons name={r.icon} size={20} color={colors.body} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{r.title}</Text>
                {r.subtitle && <Text style={styles.rowSub}>{r.subtitle}</Text>}
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.mutedSoft} />
            </Pressable>
          ))}
        </View>

        <Pressable style={styles.signOutBtn} onPress={onSignOut}>
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>

        {__DEV__ && (
          <Pressable
            style={[styles.signOutBtn, styles.devBtn]}
            onPress={async () => {
              await unregisterForPushNotifications();
              await signOut();
              await AsyncStorage.removeItem(ONBOARDING_SEEN_KEY);
              await clearActiveWorkspaceId();
              router.replace("/" as never);
            }}
          >
            <Text style={[styles.signOutText, styles.devBtnText]}>
              DEV · Reset (clear onboarding + sign out)
            </Text>
          </Pressable>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  scroll: { padding: space.lg, paddingBottom: space.xxl },
  title: { ...type$.titleLg, color: colors.ink, marginBottom: space.lg },
  profileCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 16,
    padding: space.base,
    gap: space.base,
    marginBottom: space.lg,
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
  group: {
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 16,
    overflow: "hidden",
    marginBottom: space.lg,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    padding: space.base,
    gap: space.sm,
    borderTopWidth: 1,
    borderTopColor: colors.hairlineSoft,
  },
  rowGlyph: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTitle: { ...type$.titleSm, color: colors.ink },
  rowSub: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  signOutBtn: {
    alignItems: "center",
    paddingVertical: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.hairline,
    marginTop: space.sm,
  },
  signOutText: { ...type$.button, color: colors.ink },
  devBtn: {
    marginTop: space.sm,
    borderColor: colors.accentYellow,
    borderStyle: "dashed",
  },
  devBtnText: { color: colors.body, fontSize: 13 },
});
