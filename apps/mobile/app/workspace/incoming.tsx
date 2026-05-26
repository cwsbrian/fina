import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, Pressable, Alert, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch } from "../../src/api/client";
import { setActiveWorkspaceId } from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";

type IncomingInvite = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  inviterEmail: string;
  inviterName: string | null;
  invitedRole: "editor" | "viewer";
  expiresAt: string;
  createdAt: string;
};

export default function IncomingInvites() {
  const [invites, setInvites] = useState<IncomingInvite[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch<{ invites: IncomingInvite[] }>("/me/incoming-invites");
      setInvites(r.invites);
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function accept(inv: IncomingInvite) {
    setBusyId(inv.id);
    try {
      await apiFetch(`/me/incoming-invites/${inv.id}/accept`, { method: "POST" });
      await setActiveWorkspaceId(inv.workspaceId);
      router.replace("/(tabs)" as never);
    } catch (e) {
      Alert.alert("Couldn't accept", (e as { code?: string }).code ?? "Try again.");
      setBusyId(null);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <HeaderIconButton icon="chevron-back" variant="plain" onPress={() => router.back()} />
        <Text style={styles.title}>Invitations</Text>
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        {invites === null && !err && <ActivityIndicator color={colors.primary} />}
        {err && <Text style={styles.errText}>Couldn't load ({err})</Text>}
        {invites !== null && invites.length === 0 && (
          <View style={styles.emptyWrap}>
            <Ionicons name="mail-outline" size={48} color={colors.muted} />
            <Text style={styles.emptyTitle}>No pending invitations</Text>
          </View>
        )}
        {invites !== null && invites.map((inv) => (
          <View key={inv.id} style={styles.card}>
            <Text style={styles.wsName}>{inv.workspaceName}</Text>
            <Text style={styles.meta}>
              {inv.inviterName ?? inv.inviterEmail} invited you as {inv.invitedRole}
            </Text>
            <Pressable
              style={({ pressed }) => [styles.btnPrimary, pressed && { opacity: 0.7 }]}
              onPress={() => accept(inv)}
              disabled={busyId === inv.id}
            >
              <Text style={styles.btnPrimaryText}>{busyId === inv.id ? "Joining..." : "Accept"}</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  head: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.base, gap: space.sm, height: 56 },
  title: { ...type$.titleMd, color: colors.ink },
  scroll: { padding: space.lg, gap: space.sm },
  errText: { ...type$.bodyMd, color: colors.down, textAlign: "center", marginTop: space.xxl },
  emptyWrap: { alignItems: "center", paddingVertical: space.xxl, gap: space.sm },
  emptyTitle: { ...type$.titleSm, color: colors.muted },
  card: { backgroundColor: colors.surfaceSoft, borderRadius: 16, padding: space.base, marginBottom: space.sm, gap: space.xs },
  wsName: { ...type$.titleSm, color: colors.ink },
  meta: { ...type$.bodySm, color: colors.body },
  btnPrimary: { backgroundColor: colors.primary, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center", marginTop: space.sm },
  btnPrimaryText: { ...type$.bodyMd, color: colors.onPrimary, fontWeight: "600" },
});
