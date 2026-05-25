import { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { Role, MeDTO as Me } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";

type WorkspaceSummary = { id: string; name: string; role: Role };
type Member = {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  joinedAt: string;
};
type PendingInvite = {
  id: string;
  invitedEmail: string;
  invitedRole: "editor" | "viewer";
  expiresAt: string;
  createdAt: string;
};

function initials(name: string | null, email: string): string {
  const seed = name?.trim() || email;
  const parts = seed.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return "1 month ago";
  return `${months} months ago`;
}

function roleLabel(r: Role | "editor" | "viewer"): string {
  switch (r) {
    case "owner":
      return "Owner";
    case "editor":
      return "Editor";
    case "viewer":
      return "Viewer";
  }
}

const AVATAR_TINTS = [
  "#cd6c50",
  "#1f8a5b",
  "#3eb38b",
  "#e6b85c",
  "#1c2f45",
  "#7b6cf2",
];
function tintFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_TINTS[h % AVATAR_TINTS.length]!;
}

export default function WorkspaceScreen() {
  const [me, setMe] = useState<Me | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      const [meResp, wsListResp, memResp] = await Promise.all([
        apiFetch<Me>("/me"),
        apiFetch<{ workspaces: WorkspaceSummary[] }>("/workspaces"),
        apiFetch<{ members: Member[] }>(`/workspaces/${wsId}/members`),
      ]);
      const ws = wsListResp.workspaces.find((w) => w.id === wsId) ?? null;
      setMe(meResp);
      setWorkspace(ws);
      setMembers(memResp.members);
      // Invites are owner-only — let it 403 silently for non-owners.
      if (ws?.role === "owner") {
        try {
          const invResp = await apiFetch<{ invites: PendingInvite[] }>(
            `/workspaces/${wsId}/invites`,
          );
          setInvites(invResp.invites);
        } catch {
          setInvites([]);
        }
      } else {
        setInvites([]);
      }
      setErr(null);
      setLoaded(true);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
      setLoaded(true);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const isOwner = workspace?.role === "owner";
  const myUserId = me?.user.id;

  const onMemberPress = (m: Member) => {
    if (!workspace) return;
    const isSelf = m.userId === myUserId;

    // Self: only "Leave workspace" if not owner.
    if (isSelf) {
      if (m.role === "owner") {
        Alert.alert(
          "You're the owner",
          "Transfer ownership to another member before leaving.",
        );
        return;
      }
      Alert.alert("Leave workspace?", "You'll lose access to its data.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Leave",
          style: "destructive",
          onPress: () => removeMember(m),
        },
      ]);
      return;
    }

    // Other member: only owners can manage.
    if (!isOwner) {
      Alert.alert(
        m.name ?? m.email,
        `${roleLabel(m.role)} · ${m.email}`,
        [{ text: "OK" }],
      );
      return;
    }

    // Owner managing another member — change role / transfer / remove.
    const actions: Array<{
      text: string;
      onPress?: () => void;
      style?: "default" | "destructive" | "cancel";
    }> = [];
    if (m.role !== "editor")
      actions.push({ text: "Make Editor", onPress: () => changeRole(m, "editor") });
    if (m.role !== "viewer")
      actions.push({ text: "Make Viewer", onPress: () => changeRole(m, "viewer") });
    if (m.role !== "owner")
      actions.push({
        text: "Transfer ownership",
        onPress: () => confirmTransfer(m),
      });
    actions.push({
      text: "Remove from workspace",
      style: "destructive",
      onPress: () => confirmRemove(m),
    });
    actions.push({ text: "Cancel", style: "cancel" });
    Alert.alert(m.name ?? m.email, m.email, actions);
  };

  const changeRole = async (m: Member, role: Role) => {
    if (!workspace) return;
    try {
      await apiFetch(`/workspaces/${workspace.id}/members/${m.userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      load();
    } catch (e) {
      Alert.alert("Couldn't update role", (e as { code?: string }).code ?? "error");
    }
  };

  const confirmTransfer = (m: Member) => {
    Alert.alert(
      `Make ${m.name ?? m.email} the owner?`,
      "You'll become an editor. Only the owner can manage members and billing.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Transfer",
          style: "destructive",
          onPress: async () => {
            if (!workspace) return;
            try {
              await apiFetch(
                `/workspaces/${workspace.id}/members/${m.userId}`,
                {
                  method: "PATCH",
                  body: JSON.stringify({ role: "owner" }),
                },
              );
              load();
            } catch (e) {
              Alert.alert(
                "Couldn't transfer ownership",
                (e as { code?: string }).code ?? "error",
              );
            }
          },
        },
      ],
    );
  };

  const confirmRemove = (m: Member) => {
    Alert.alert(
      `Remove ${m.name ?? m.email}?`,
      "They lose access to this workspace immediately. Their past changes stay.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => removeMember(m),
        },
      ],
    );
  };

  const removeMember = async (m: Member) => {
    if (!workspace) return;
    try {
      await apiFetch(`/workspaces/${workspace.id}/members/${m.userId}`, {
        method: "DELETE",
      });
      const isSelf = m.userId === myUserId;
      if (isSelf) {
        router.replace("/" as never);
      } else {
        load();
      }
    } catch (e) {
      Alert.alert(
        "Couldn't remove member",
        (e as { code?: string }).code ?? "error",
      );
    }
  };

  const onInvitePress = (inv: PendingInvite) => {
    Alert.alert(
      inv.invitedEmail,
      `Invited ${relativeTime(inv.createdAt)} · ${roleLabel(inv.invitedRole)}`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Revoke invite",
          style: "destructive",
          onPress: () => revokeInvite(inv),
        },
      ],
    );
  };

  const revokeInvite = async (inv: PendingInvite) => {
    if (!workspace) return;
    try {
      await apiFetch(`/workspaces/${workspace.id}/invites/${inv.id}`, {
        method: "DELETE",
      });
      load();
    } catch (e) {
      Alert.alert(
        "Couldn't revoke",
        (e as { code?: string }).code ?? "error",
      );
    }
  };

  if (!loaded) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Header />
        <View style={styles.fallback}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (err || !workspace) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Header />
        <View style={styles.fallback}>
          <Text style={styles.errTitle}>Couldn't load workspace</Text>
          <Text style={styles.errBody}>{err ?? "no_workspace"}</Text>
          <Pressable style={styles.cta} onPress={load}>
            <Text style={styles.ctaText}>Try again</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const heroLetter = workspace.name.trim()[0]?.toUpperCase() ?? "W";

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Header />
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
      >
        <View style={styles.hero}>
          <View style={styles.heroMark}>
            <Text style={styles.heroMarkText}>{heroLetter}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.heroName}>{workspace.name}</Text>
            <View style={styles.heroMetaRow}>
              <Text style={styles.heroMetaText}>
                {members.length} member{members.length === 1 ? "" : "s"}
              </Text>
              {invites.length > 0 && (
                <>
                  <View style={styles.heroDot} />
                  <Text style={styles.heroMetaText}>
                    {invites.length} pending
                  </Text>
                </>
              )}
              <View style={styles.heroDot} />
              <Text style={styles.heroMetaTextMuted}>
                {roleLabel(workspace.role)}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.sectionHead}>
          <Text style={styles.sectionLabel}>Members</Text>
          {isOwner && (
            <Pressable
              style={({ pressed }) => [
                styles.inviteBtn,
                pressed && { opacity: 0.7 },
              ]}
              onPress={() => router.push("/workspace/invite" as never)}
            >
              <Ionicons name="add" size={14} color={colors.primary} />
              <Text style={styles.inviteBtnText}>Invite</Text>
            </Pressable>
          )}
        </View>

        <View style={styles.group}>
          {members.map((m, i) => {
            const isSelf = m.userId === myUserId;
            return (
              <Pressable
                key={m.userId}
                style={({ pressed }) => [
                  styles.memberRow,
                  i > 0 && styles.memberRowBorder,
                  pressed && { backgroundColor: colors.surfaceSoft },
                ]}
                onPress={() => onMemberPress(m)}
              >
                <View
                  style={[
                    styles.avatar,
                    { backgroundColor: isSelf ? colors.ink : tintFor(m.userId) },
                  ]}
                >
                  <Text style={styles.avatarText}>
                    {initials(m.name, m.email)[0]}
                  </Text>
                </View>
                <View style={styles.memberBody}>
                  <View style={styles.memberNameRow}>
                    <Text style={styles.memberName} numberOfLines={1}>
                      {m.name ?? m.email}
                    </Text>
                    {isSelf && (
                      <View style={styles.youPill}>
                        <Text style={styles.youPillText}>You</Text>
                      </View>
                    )}
                  </View>
                  {m.name && (
                    <Text style={styles.memberMail} numberOfLines={1}>
                      {m.email}
                    </Text>
                  )}
                </View>
                <View
                  style={[
                    styles.rolePill,
                    m.role === "owner" && styles.rolePillOwner,
                  ]}
                >
                  <Text
                    style={[
                      styles.rolePillText,
                      m.role === "owner" && styles.rolePillTextOwner,
                    ]}
                  >
                    {roleLabel(m.role).toUpperCase()}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>

        {invites.length > 0 && (
          <>
            <View style={styles.sectionHead}>
              <Text style={styles.sectionLabel}>Pending invites</Text>
            </View>
            <View style={styles.group}>
              {invites.map((inv, i) => (
                <Pressable
                  key={inv.id}
                  style={({ pressed }) => [
                    styles.memberRow,
                    i > 0 && styles.memberRowBorder,
                    pressed && { backgroundColor: colors.surfaceSoft },
                  ]}
                  onPress={() => onInvitePress(inv)}
                >
                  <View style={[styles.avatar, styles.avatarPending]}>
                    <Ionicons
                      name="mail-outline"
                      size={16}
                      color={colors.muted}
                    />
                  </View>
                  <View style={styles.memberBody}>
                    <Text style={styles.memberName} numberOfLines={1}>
                      {inv.invitedEmail}
                    </Text>
                    <Text style={styles.memberMail} numberOfLines={1}>
                      Invited {relativeTime(inv.createdAt)} ·{" "}
                      {roleLabel(inv.invitedRole)}
                    </Text>
                  </View>
                  <View style={[styles.rolePill, styles.rolePillPending]}>
                    <Text style={styles.rolePillText}>PENDING</Text>
                  </View>
                </Pressable>
              ))}
            </View>
          </>
        )}

        <Text style={styles.helper}>
          {isOwner
            ? "Tap a member to change role, transfer ownership, or remove."
            : "Only the workspace owner can manage members or send invites."}
        </Text>
      </ScrollView>
    </SafeAreaView>
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
      <Text style={styles.navTitle}>Workspace</Text>
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
  fallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space.xl,
  },
  errTitle: { ...type$.titleMd, color: colors.down, marginBottom: 4 },
  errBody: {
    ...type$.bodyMd,
    color: colors.body,
    marginBottom: space.base,
    textAlign: "center",
  },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: 999,
  },
  ctaText: { ...type$.bodyMd, color: colors.onPrimary, fontWeight: "600" },

  hero: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm + 2,
    paddingVertical: space.base,
    paddingHorizontal: space.sm,
    marginBottom: space.base,
  },
  heroMark: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  heroMarkText: {
    fontSize: 22,
    fontWeight: "600",
    color: colors.canvas,
  },
  heroName: { ...type$.titleMd, color: colors.ink, fontWeight: "600" },
  heroMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 2,
  },
  heroMetaText: { ...type$.bodySm, color: colors.body },
  heroMetaTextMuted: { ...type$.bodySm, color: colors.muted },
  heroDot: {
    width: 3,
    height: 3,
    borderRadius: 999,
    backgroundColor: colors.mutedSoft,
  },

  sectionHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: space.lg,
    marginBottom: space.sm,
    paddingHorizontal: 4,
  },
  sectionLabel: {
    ...type$.captionStrong,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  inviteBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(62, 179, 139, 0.16)",
  },
  inviteBtnText: { ...type$.bodySm, color: colors.primary, fontWeight: "600" },

  group: {
    backgroundColor: colors.canvas,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.hairlineSoft,
    overflow: "hidden",
  },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm + 2,
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.base,
  },
  memberRowBorder: {
    borderTopWidth: 1,
    borderTopColor: colors.hairlineSoft,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarPending: {
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: colors.hairlineSoft,
    borderStyle: "dashed",
  },
  avatarText: { fontSize: 14, fontWeight: "600", color: colors.canvas },
  memberBody: { flex: 1, minWidth: 0 },
  memberNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  memberName: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  memberMail: { ...type$.bodySm, color: colors.muted, marginTop: 1 },
  youPill: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
  },
  youPillText: { ...type$.caption, color: colors.muted, fontWeight: "600" },
  rolePill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
  },
  rolePillOwner: { backgroundColor: colors.ink },
  rolePillPending: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: colors.hairlineSoft,
    borderStyle: "dashed",
  },
  rolePillText: {
    ...type$.caption,
    color: colors.muted,
    fontWeight: "700",
    letterSpacing: 0.6,
  },
  rolePillTextOwner: { color: colors.canvas },

  helper: {
    ...type$.bodySm,
    color: colors.muted,
    textAlign: "center",
    marginTop: space.lg,
    paddingHorizontal: space.lg,
  },
});
