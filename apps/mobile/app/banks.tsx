import { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  ActivityIndicator,
  Alert,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, bootstrapActiveWorkspace } from "../src/api/client";
import { getActiveWorkspaceId } from "../src/workspace/active";
import { colors, space, type as type$ } from "../src/design/tokens";
import { HeaderIconButton } from "../src/design/HeaderIconButton";
import { ConnectBankButton } from "../src/plaid/ConnectBankButton";

type PlaidItem = {
  id: string;
  institutionName: string;
  status: string;
  errorCode: string | null;
  lastSyncAt: string | null;
  billingGraceEndsAt: string | null;
  accountCount: number;
};

export default function BanksScreen() {
  const [items, setItems] = useState<PlaidItem[] | null>(null);
  const [reconnectRequired, setReconnectRequired] = useState(false);
  const [canConnectBank, setCanConnectBank] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      const data = await apiFetch<{
        plaidItems: PlaidItem[];
        reconnectRequired: boolean;
        canConnectBank: boolean;
      }>(
        `/workspaces/${wsId}/plaid-items`,
      );
      setItems(data.plaidItems);
      setReconnectRequired(data.reconnectRequired);
      setCanConnectBank(data.canConnectBank);
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
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

  const onSync = async (itemId: string) => {
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) throw new Error("no_workspace");
      await apiFetch(`/workspaces/${wsId}/plaid-items/${itemId}/sync`, {
        method: "POST",
      });
      await load();
    } catch (e) {
      Alert.alert(
        "Sync failed",
        (e as { code?: string }).code ?? "Try again.",
      );
    }
  };

  const disconnectItem = async (itemId: string, deleteTransactions: boolean) => {
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) throw new Error("no_workspace");
      await apiFetch(
        `/workspaces/${wsId}/plaid-items/${itemId}${deleteTransactions ? "?deleteTransactions=true" : ""}`,
        { method: "DELETE" },
      );
      await load();
    } catch (e) {
      Alert.alert(
        "Disconnect failed",
        (e as { code?: string }).code ?? "Try again.",
      );
    }
  };

  const onDisconnect = (itemId: string, name: string) => {
    Alert.alert(
      `Disconnect ${name}?`,
      "This removes the connection and stops new transaction imports.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Keep transactions",
          onPress: () => void disconnectItem(itemId, false),
        },
        {
          text: "Delete transactions",
          style: "destructive",
          onPress: () => void disconnectItem(itemId, true),
        },
      ],
    );
  };

  const graceItems =
    items?.filter(
      (item) =>
        item.billingGraceEndsAt !== null &&
        new Date(item.billingGraceEndsAt).getTime() > Date.now(),
    ) ?? [];
  const graceEndsAt = graceItems
    .map((item) => item.billingGraceEndsAt!)
    .sort()[0] ?? null;

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
        <Text style={styles.title}>Banks</Text>
        <View style={{ width: 34 }} />
      </View>

      {!items && !err && (
        <View style={styles.fallback}>
          <ActivityIndicator color={colors.primary} />
        </View>
      )}

      {err && (
        <View style={styles.fallback}>
          <Text style={styles.errTitle}>Couldn't load banks</Text>
          <Text style={styles.errBody}>{err}</Text>
          <Pressable style={styles.cta} onPress={load}>
            <Text style={styles.ctaText}>Try again</Text>
          </Pressable>
        </View>
      )}

      {items && items.length === 0 && (
        <View style={styles.fallback}>
          <View style={styles.iconWrap}>
            <Ionicons name="card-outline" size={32} color={colors.muted} />
          </View>
          <Text style={styles.emptyTitle}>
            {reconnectRequired ? "Reconnect your bank" : "No banks connected"}
          </Text>
          <Text style={styles.emptyBody}>
            {reconnectRequired
              ? canConnectBank
                ? "Your previous connection ended after a plan change. Link it again to resume automatic imports."
                : "Your plan no longer includes automatic bank imports. Upgrade to reconnect your bank."
              : "Securely link your bank via Plaid so Fina can import transactions automatically."}
          </Text>
          {reconnectRequired && !canConnectBank ? (
            <Pressable style={styles.cta} onPress={() => router.push("/plan" as never)}>
              <Text style={styles.ctaText}>View plans</Text>
            </Pressable>
          ) : (
            <ConnectBankButton
              onConnected={load}
              {...(reconnectRequired ? { label: "Reconnect bank" } : {})}
            />
          )}
        </View>
      )}

      {items && items.length > 0 && (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
            />
          }
          renderItem={({ item }) => (
            <View
              style={[
                styles.row,
                item.billingGraceEndsAt ? styles.rowGrace : null,
              ]}
            >
              <View style={styles.rowGlyph}>
                <Ionicons name="card-outline" size={18} color={colors.muted} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {item.institutionName}
                </Text>
                <Text style={styles.rowMeta}>
                  {item.accountCount} account{item.accountCount === 1 ? "" : "s"}
                  {item.lastSyncAt
                    ? ` · synced ${new Date(item.lastSyncAt).toLocaleDateString()}`
                    : ""}
                  {item.status === "error" || item.errorCode
                    ? ` · ${item.errorCode ?? "needs attention"}`
                    : ""}
                  {item.billingGraceEndsAt
                    ? ` · disconnects ${new Date(item.billingGraceEndsAt).toLocaleDateString()}`
                    : ""}
                </Text>
              </View>
              {!item.billingGraceEndsAt && (
                <Pressable
                  style={({ pressed }) => [
                    styles.rowAction,
                    pressed && { opacity: 0.6 },
                  ]}
                  onPress={() => onSync(item.id)}
                >
                  <Ionicons name="refresh" size={18} color={colors.primary} />
                </Pressable>
              )}
              <Pressable
                style={({ pressed }) => [
                  styles.rowAction,
                  pressed && { opacity: 0.6 },
                ]}
                onPress={() => onDisconnect(item.id, item.institutionName)}
              >
                <Ionicons name="trash-outline" size={18} color={colors.down} />
              </Pressable>
            </View>
          )}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          ListHeaderComponent={
            graceEndsAt ? (
              <View style={styles.graceBanner}>
                <Ionicons name="time-outline" size={20} color={colors.accentYellow} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.graceTitle}>Bank connection in 30-day grace period</Text>
                  <Text style={styles.graceBody}>
                    New transactions are saved securely but hidden on Free. Upgrade by{" "}
                    {new Date(graceEndsAt).toLocaleDateString()} to restore them without
                    reconnecting your bank.
                  </Text>
                  <Pressable
                    style={styles.graceCta}
                    onPress={() => router.push("/plan" as never)}
                  >
                    <Text style={styles.graceCtaText}>View plans</Text>
                  </Pressable>
                </View>
              </View>
            ) : null
          }
          ListFooterComponent={
            canConnectBank ? (
              <View style={{ padding: space.lg }}>
                <ConnectBankButton onConnected={load} label="Connect another bank" />
              </View>
            ) : null
          }
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
  emptyTitle: { ...type$.titleMd, color: colors.ink, marginBottom: 6, textAlign: "center" },
  emptyBody: {
    ...type$.bodyMd,
    color: colors.body,
    textAlign: "center",
    maxWidth: 320,
    marginBottom: space.lg,
  },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.base,
  },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: space.xl,
    paddingVertical: 14,
    borderRadius: 999,
  },
  ctaText: { ...type$.button, color: colors.onPrimary },
  list: { paddingVertical: space.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
  rowGrace: { opacity: 0.58 },
  rowGlyph: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTitle: { ...type$.titleSm, color: colors.ink },
  rowMeta: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  rowAction: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
  },
  sep: { height: 1, backgroundColor: colors.hairlineSoft, marginLeft: 24 + 40 + 12 },
  graceBanner: {
    flexDirection: "row",
    gap: space.sm,
    marginHorizontal: space.lg,
    marginVertical: space.sm,
    padding: space.base,
    borderRadius: 16,
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: colors.hairlineSoft,
  },
  graceTitle: { ...type$.titleSm, color: colors.ink },
  graceBody: { ...type$.bodySm, color: colors.body, marginTop: 4 },
  graceCta: { alignSelf: "flex-start", marginTop: space.sm },
  graceCtaText: { ...type$.button, color: colors.primary },
});
