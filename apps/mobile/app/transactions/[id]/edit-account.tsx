import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  ActivityIndicator,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { BankAccountDTO, TransactionDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../../src/api/client";
import { getActiveWorkspaceId } from "../../../src/workspace/active";
import { colors, space, type as type$ } from "../../../src/design/tokens";
import { HeaderIconButton } from "../../../src/design/HeaderIconButton";

type AccountsResp = { accounts: BankAccountDTO[] };
type SingleTxResp = { transaction: TransactionDTO };

function accountLabel(a: BankAccountDTO): string {
  const name = a.name || a.officialName || "Account";
  return a.mask ? `${name} ··${a.mask}` : name;
}

export default function EditAccount() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [accounts, setAccounts] = useState<BankAccountDTO[] | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      const [acctsResp, txResp] = await Promise.all([
        apiFetch<AccountsResp>(`/workspaces/${wsId}/accounts`),
        apiFetch<SingleTxResp>(`/workspaces/${wsId}/transactions/${id}`),
      ]);
      // Only manual accounts are valid reassign targets — the API rejects
      // plaid-linked rows on PATCH accountId.
      setAccounts(
        acctsResp.accounts.filter(
          (a) => a.plaidAccountId === null && a.status === "active",
        ),
      );
      setCurrentId(txResp.transaction.accountId);
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const pick = async (a: BankAccountDTO) => {
    if (!id || saving) return;
    setSaving(a.id);
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) throw new Error("no_workspace");
      await apiFetch(`/workspaces/${wsId}/transactions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ accountId: a.id }),
      });
      router.back();
    } catch (e) {
      setSaving(null);
      Alert.alert(
        "Couldn't update account",
        (e as { code?: string }).code ?? "Try again.",
      );
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <HeaderIconButton
          icon="chevron-back"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          variant="plain"
        />
        <Text style={styles.title}>Account</Text>
        <View style={{ width: 34 }} />
      </View>

      {!accounts && !err && (
        <View style={styles.fallback}>
          <ActivityIndicator color={colors.primary} />
        </View>
      )}

      {err && (
        <View style={styles.fallback}>
          <Text style={styles.errTitle}>Couldn't load accounts</Text>
          <Text style={styles.errBody}>{err}</Text>
          <Pressable style={styles.cta} onPress={load}>
            <Text style={styles.ctaText}>Try again</Text>
          </Pressable>
        </View>
      )}

      {accounts && accounts.length === 0 && (
        <View style={styles.fallback}>
          <Text style={styles.emptyTitle}>No manual accounts</Text>
          <Text style={styles.emptyBody}>
            Manual transactions can only be moved between manual accounts.
          </Text>
        </View>
      )}

      {accounts && accounts.length > 0 && (
        <FlatList
          data={accounts}
          keyExtractor={(a) => a.id}
          contentContainerStyle={{ paddingVertical: space.sm }}
          renderItem={({ item }) => {
            const isSel = item.id === currentId;
            const isSaving = saving === item.id;
            return (
              <Pressable
                style={({ pressed }) => [
                  styles.row,
                  pressed && { backgroundColor: colors.surfaceSoft },
                ]}
                disabled={!!saving || isSel}
                onPress={() => pick(item)}
              >
                <View style={styles.glyph}>
                  <Ionicons
                    name="card-outline"
                    size={16}
                    color={colors.muted}
                  />
                </View>
                <Text style={styles.name}>{accountLabel(item)}</Text>
                {isSaving ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : isSel ? (
                  <View style={styles.selectedMark}>
                    <Ionicons name="checkmark" size={14} color={colors.onPrimary} />
                  </View>
                ) : null}
              </Pressable>
            );
          }}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
        />
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
  fallback: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
  errTitle: { ...type$.titleMd, color: colors.down, marginBottom: 4 },
  errBody: { ...type$.bodyMd, color: colors.body, marginBottom: space.base, textAlign: "center" },
  emptyTitle: { ...type$.titleMd, color: colors.ink, marginBottom: 4, textAlign: "center" },
  emptyBody: { ...type$.bodyMd, color: colors.body, textAlign: "center", maxWidth: 280 },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: space.xl,
    paddingVertical: 14,
    borderRadius: 999,
  },
  ctaText: { ...type$.button, color: colors.onPrimary },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
  glyph: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  name: { ...type$.bodyMd, color: colors.ink, fontWeight: "600", flex: 1 },
  sep: { height: 1, backgroundColor: colors.hairlineSoft, marginLeft: 24 + 34 + 12 },
  selectedMark: {
    width: 22,
    height: 22,
    borderRadius: 999,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
});
