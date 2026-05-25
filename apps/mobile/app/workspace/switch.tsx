import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { Role } from "@fina/shared";
import { apiFetch } from "../../src/api/client";
import {
  getActiveWorkspaceId,
  setActiveWorkspaceId,
} from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";

type Workspace = {
  id: string;
  name: string;
  role: Role;
  currency: string;
};

type Member = { userId: string };

function roleLabel(r: Role): string {
  return r === "owner" ? "Owner" : r === "editor" ? "Editor" : "Viewer";
}

const TINTS = ["#1c2f45", "#3eb38b", "#cd6c50", "#e6b85c", "#7b6cf2", "#1f8a5b"];
function tintFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length]!;
}

export default function SwitchWorkspace() {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cur = await getActiveWorkspaceId();
        if (!cancelled) setActiveId(cur);
        const list = await apiFetch<{ workspaces: Workspace[] }>(
          "/workspaces",
        );
        if (cancelled) return;
        setWorkspaces(list.workspaces);
        // Best-effort member counts — show "just you" when 1, otherwise N.
        const entries = await Promise.all(
          list.workspaces.map(async (w) => {
            try {
              const m = await apiFetch<{ members: Member[] }>(
                `/workspaces/${w.id}/members`,
              );
              return [w.id, m.members.length] as const;
            } catch {
              return [w.id, 1] as const;
            }
          }),
        );
        if (!cancelled) {
          setCounts(Object.fromEntries(entries));
        }
      } catch {
        if (!cancelled) setWorkspaces([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = useCallback(
    async (w: Workspace) => {
      if (w.id === activeId || switching) return;
      setSwitching(w.id);
      try {
        await setActiveWorkspaceId(w.id);
        // Replace home so the tabs reload against the new workspace.
        router.replace("/(tabs)" as never);
      } catch {
        setSwitching(null);
      }
    },
    [activeId, switching],
  );

  if (!workspaces) {
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

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Header />
      <ScrollView contentContainerStyle={styles.scroll}>
        {workspaces.map((w) => {
          const n = counts[w.id] ?? 1;
          const memberLine =
            n === 1 ? "just you" : `${n} member${n === 1 ? "" : "s"}`;
          const isActive = w.id === activeId;
          return (
            <Pressable
              key={w.id}
              style={({ pressed }) => [
                styles.row,
                pressed && { backgroundColor: colors.surfaceSoft },
              ]}
              onPress={() => choose(w)}
              disabled={!!switching}
            >
              <View
                style={[styles.mark, { backgroundColor: tintFor(w.id) }]}
              >
                <Text style={styles.markText}>
                  {w.name.trim()[0]?.toUpperCase() ?? "W"}
                </Text>
              </View>
              <View style={styles.body}>
                <Text style={styles.name} numberOfLines={1}>
                  {w.name}
                </Text>
                <Text style={styles.meta}>
                  {roleLabel(w.role)} · {memberLine}
                </Text>
              </View>
              {isActive ? (
                <View style={styles.check}>
                  <Ionicons name="checkmark" size={14} color={colors.canvas} />
                </View>
              ) : switching === w.id ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : null}
            </Pressable>
          );
        })}

        <Pressable
          style={({ pressed }) => [
            styles.create,
            pressed && { opacity: 0.7 },
          ]}
          onPress={() => router.push("/workspace/new" as never)}
        >
          <View style={styles.plus}>
            <Ionicons name="add" size={18} color={colors.primary} />
          </View>
          <View style={styles.body}>
            <Text style={styles.createTitle}>Create new workspace</Text>
            <Text style={styles.meta}>
              For a new project, business, or another household.
            </Text>
          </View>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function Header() {
  return (
    <View style={styles.nav}>
      <Pressable onPress={() => router.back()} hitSlop={8}>
        <Text style={styles.cancel}>Done</Text>
      </Pressable>
      <Text style={styles.navTitle}>Switch workspace</Text>
      <View style={{ width: 40 }} />
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
  cancel: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },
  scroll: { padding: space.lg },
  fallback: { flex: 1, alignItems: "center", justifyContent: "center" },

  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm + 2,
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.sm,
    borderRadius: 14,
  },
  mark: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  markText: { ...type$.titleSm, color: colors.canvas, fontWeight: "600" },
  body: { flex: 1, minWidth: 0 },
  name: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  meta: { ...type$.bodySm, color: colors.muted, marginTop: 1 },
  check: {
    width: 22,
    height: 22,
    borderRadius: 999,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },

  create: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm + 2,
    marginTop: space.lg,
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.sm,
    borderRadius: 14,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.hairline,
  },
  plus: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "rgba(62, 179, 139, 0.16)",
    alignItems: "center",
    justifyContent: "center",
  },
  createTitle: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },
});
