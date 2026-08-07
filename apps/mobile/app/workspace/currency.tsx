import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";

const CURRENCIES = [
  { code: "CAD", label: "Canadian dollar", symbol: "$" },
  { code: "USD", label: "US dollar", symbol: "$" },
  { code: "EUR", label: "Euro", symbol: "€" },
  { code: "GBP", label: "British pound", symbol: "£" },
  { code: "KRW", label: "South Korean won", symbol: "₩" },
  { code: "JPY", label: "Japanese yen", symbol: "¥" },
] as const;

type WorkspaceSummary = {
  id: string;
  currency: string;
  role: "owner" | "editor" | "viewer";
};

export default function WorkspaceCurrency() {
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [customCurrency, setCustomCurrency] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const wsId = (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
        if (!wsId) throw new Error("no_workspace");
        const data = await apiFetch<{ workspaces: WorkspaceSummary[] }>("/workspaces");
        const active = data.workspaces.find((item) => item.id === wsId);
        if (!active) throw new Error("workspace_not_found");
        if (!cancelled) {
          setWorkspace(active);
          setCurrency(active.currency);
          if (!CURRENCIES.some((item) => item.code === active.currency)) {
            setCustomCurrency(active.currency);
          }
        }
      } catch (e) {
        if (!cancelled) setErr((e as { code?: string }).code ?? "load_failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(() => {
    if (!workspace || !currency || currency === workspace.currency || submitting) return;
    Alert.alert(
      `Change currency to ${currency}?`,
      "Existing amounts will not be converted. Their numbers stay the same and only the currency label changes across this workspace.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Change currency",
          style: "destructive",
          onPress: async () => {
            setSubmitting(true);
            setErr(null);
            try {
              await apiFetch(`/workspaces/${workspace.id}/currency`, {
                method: "PATCH",
                body: JSON.stringify({ currency }),
              });
              router.back();
            } catch (e) {
              setErr((e as { code?: string }).code ?? "save_failed");
              setSubmitting(false);
            }
          },
        },
      ],
    );
  }, [currency, submitting, workspace]);

  const canSave =
    workspace?.role === "owner" && currency !== null && currency !== workspace.currency && !submitting;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <Pressable onPress={() => router.back()} disabled={submitting} hitSlop={8}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>Currency</Text>
        <Pressable onPress={save} disabled={!canSave} hitSlop={8}>
          {submitting ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text style={[styles.save, !canSave && { opacity: 0.4 }]}>Save</Text>
          )}
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          <View style={styles.notice}>
            <Ionicons name="information-circle-outline" size={18} color={colors.navy} />
            <Text style={styles.noticeText}>
              Fina uses one currency per workspace. Changing it updates transaction, budget, and
              summary labels. It does not exchange or recalculate existing amounts.
            </Text>
          </View>

          <View style={styles.list}>
            {CURRENCIES.map((item, index) => {
              const selected = currency === item.code;
              return (
                <Pressable
                  key={item.code}
                  style={[styles.row, index < CURRENCIES.length - 1 && styles.rowBorder]}
                  onPress={() => {
                    setCustomCurrency("");
                    setCurrency(item.code);
                  }}
                  disabled={workspace?.role !== "owner" || submitting}
                >
                  <View style={styles.symbolBox}>
                    <Text style={styles.symbol}>{item.symbol}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.code}>{item.code}</Text>
                    <Text style={styles.label}>{item.label}</Text>
                  </View>
                  {selected && <Ionicons name="checkmark-circle" size={22} color={colors.primary} />}
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.customLabel}>Other currency</Text>
          <TextInput
            style={styles.customInput}
            value={customCurrency}
            onChangeText={(text) => {
              const normalized = text.replace(/[^a-z]/gi, "").toUpperCase().slice(0, 3);
              setCustomCurrency(normalized);
              setCurrency(normalized.length === 3 ? normalized : null);
            }}
            placeholder="ISO code, e.g. CHF"
            placeholderTextColor={colors.mutedSoft}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={3}
            editable={workspace?.role === "owner" && !submitting}
          />
          {workspace?.role !== "owner" && (
            <Text style={styles.error}>Only a workspace owner can change the currency.</Text>
          )}
          {err && <Text style={styles.error}>Couldn't update currency: {err}</Text>}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.base,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  title: { ...type$.titleSm, color: colors.ink, fontWeight: "600" },
  cancel: { ...type$.bodyMd, color: colors.muted },
  save: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  body: { padding: space.lg, paddingBottom: space.xl },
  notice: {
    flexDirection: "row",
    gap: space.sm,
    padding: space.base,
    borderRadius: 14,
    backgroundColor: colors.surfaceSoft,
    marginBottom: space.lg,
  },
  noticeText: { ...type$.bodySm, color: colors.body, flex: 1, lineHeight: 20 },
  list: {
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 16,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.base,
    paddingVertical: 14,
  },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.hairlineSoft },
  symbolBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  symbol: { ...type$.titleSm, color: colors.ink },
  code: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  label: { ...type$.bodySm, color: colors.muted, marginTop: 1 },
  error: { ...type$.bodySm, color: colors.down, marginTop: space.base },
  customLabel: {
    ...type$.bodySm,
    color: colors.muted,
    fontWeight: "600",
    marginTop: space.lg,
    marginBottom: space.xs,
  },
  customInput: {
    ...type$.titleSm,
    color: colors.ink,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 12,
    paddingHorizontal: space.base,
    paddingVertical: 12,
    letterSpacing: 1,
  },
});
