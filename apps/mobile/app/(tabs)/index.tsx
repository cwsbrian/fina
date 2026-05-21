import { useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { MeDTO as Me, WorkspaceSummary as Workspace } from "@fina/shared";
import { useSession, signOut } from "../../src/auth/client";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { ONBOARDING_SEEN_KEY } from "../../src/onboarding/storage";
import { clearActiveWorkspaceId } from "../../src/workspace/active";

export default function Home() {
  const { data: session } = useSession();
  const [me, setMe] = useState<Me | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const activeId = await bootstrapActiveWorkspace();
        const [meData, wsData] = await Promise.all([
          apiFetch<Me>("/me"),
          apiFetch<{ workspaces: Workspace[] }>("/workspaces"),
        ]);
        if (cancelled) return;
        setMe(meData);
        setWorkspace(
          wsData.workspaces.find((w) => w.id === activeId) ?? wsData.workspaces[0] ?? null,
        );
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View style={styles.root}>
      <Text style={styles.h1}>
        Welcome{session?.user?.name ? `, ${session.user.name}` : ""}
      </Text>
      {!me && !err && <ActivityIndicator />}
      {err && <Text style={styles.err}>Could not reach API: {err}</Text>}
      {me && workspace && (
        <View style={styles.card}>
          <Text style={styles.label}>Workspace</Text>
          <Text style={styles.value}>{workspace.name}</Text>
          <Text style={styles.label}>Role</Text>
          <Text style={styles.value}>{workspace.role}</Text>
          <Text style={styles.label}>Tier</Text>
          <Text style={styles.value}>{me.tier.toUpperCase()}</Text>
          {me.trial.active && (
            <Text style={styles.trial}>
              Pro trial active — ends {new Date(me.trial.endsAt!).toLocaleDateString()}
            </Text>
          )}
        </View>
      )}
      <Pressable style={styles.btn} onPress={() => signOut()}>
        <Text style={styles.btnText}>Sign out</Text>
      </Pressable>

      {__DEV__ && (
        <Pressable
          style={[styles.btn, styles.devBtn]}
          onPress={async () => {
            await signOut();
            await AsyncStorage.removeItem(ONBOARDING_SEEN_KEY);
            await clearActiveWorkspaceId();
            router.replace("/");
          }}
        >
          <Text style={[styles.btnText, styles.devBtnText]}>
            DEV · Reset (sign out + clear onboarding)
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 24, backgroundColor: "#fff", justifyContent: "center" },
  h1: { fontSize: 28, fontWeight: "700", marginBottom: 24 },
  card: { borderWidth: 1, borderColor: "#eee", borderRadius: 12, padding: 16, marginBottom: 24 },
  label: { fontSize: 12, opacity: 0.5, marginTop: 8 },
  value: { fontSize: 18, fontWeight: "600" },
  trial: { fontSize: 12, marginTop: 12, color: "#0a7" },
  err: { color: "#c00", marginBottom: 16 },
  btn: {
    padding: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ddd",
    alignItems: "center",
  },
  btnText: { fontSize: 16 },
  devBtn: { marginTop: 12, borderColor: "#f59e0b", borderStyle: "dashed" },
  devBtnText: { fontSize: 12, color: "#b45309" },
});
