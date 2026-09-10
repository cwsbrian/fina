import { useCallback, useState, type ReactNode } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type {
  TransactionDTO,
  CategoryDTO,
  BankAccountDTO,
  ReceiptDocumentDTO,
} from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace, bootstrapActiveWorkspaceSummary } from "../../../src/api/client";
import { getActiveWorkspaceId } from "../../../src/workspace/active";
import { formatMoney } from "../../../src/format/money";
import { colors, space, type as type$ } from "../../../src/design/tokens";
import { HeaderIconButton } from "../../../src/design/HeaderIconButton";
import { categoryMeta } from "../../../src/categories/meta";
import { CategoryPickerSheet } from "../../../src/categories/CategoryPickerSheet";
import { DatePickerSheet } from "../../../src/datetime/DatePickerSheet";
import { AccountPickerSheet } from "../../../src/accounts/AccountPickerSheet";
import { pickAndUploadReceipt, type ReceiptRole, type ReceiptSource } from "../../../src/receipts/upload";

type SingleTxResp = { transaction: TransactionDTO };
type AccountsResp = { accounts: BankAccountDTO[] };
type CategoriesResp = { categories: CategoryDTO[] };

export default function TransactionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [tx, setTx] = useState<TransactionDTO | null>(null);
  const [account, setAccount] = useState<BankAccountDTO | null>(null);
  const [categories, setCategories] = useState<Record<string, CategoryDTO>>({});
  const [err, setErr] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [accountPickerOpen, setAccountPickerOpen] = useState(false);
  const [savingBudgetImpact, setSavingBudgetImpact] = useState(false);
  const [isBusiness, setIsBusiness] = useState(false);
  const [receipts, setReceipts] = useState<ReceiptDocumentDTO[]>([]);
  const [uploadingReceipt, setUploadingReceipt] = useState(false);
  const [savingBusinessUse, setSavingBusinessUse] = useState(false);
  const [canEditBusiness, setCanEditBusiness] = useState(false);
  const [canEditWorkspace, setCanEditWorkspace] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const workspace = await bootstrapActiveWorkspaceSummary();
      const wsId = workspace?.id ?? (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId || !workspace) throw new Error("no_workspace");
      setIsBusiness(workspace.kind === "business");
      setCanEditBusiness(workspace.role !== "viewer");
      setCanEditWorkspace(workspace.role !== "viewer");
      const [t, a, c, receiptData] = await Promise.all([
        apiFetch<SingleTxResp>(`/workspaces/${wsId}/transactions/${id}`),
        apiFetch<AccountsResp>(`/workspaces/${wsId}/accounts`),
        apiFetch<CategoriesResp>(`/workspaces/${wsId}/categories`),
        workspace.kind === "business"
          ? apiFetch<{ receipts: ReceiptDocumentDTO[] }>(`/workspaces/${wsId}/transactions/${id}/receipts`)
          : Promise.resolve({ receipts: [] }),
      ]);
      setTx(t.transaction);
      setAccount(a.accounts.find((x) => x.id === t.transaction.accountId) ?? null);
      setCategories(Object.fromEntries(c.categories.map((x) => [x.id, x])));
      setReceipts(receiptData.receipts);
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, [id]);

  // Reload on focus so the category change/note edits done elsewhere
  // (e.g. picker push → back) reflect immediately.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onDelete = () => {
    if (!tx) return;
    Alert.alert("Delete transaction?", "This hides it from your activity.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            const wsId = await getActiveWorkspaceId();
            if (!wsId) throw new Error("no_workspace");
            await apiFetch(`/workspaces/${wsId}/transactions/${tx.id}`, {
              method: "DELETE",
            });
            router.back();
          } catch (e) {
            Alert.alert(
              "Couldn't delete",
              (e as { code?: string }).code ?? "Try again.",
            );
          }
        },
      },
    ]);
  };

  if (err) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Header onBack={() => router.back()} />
        <View style={styles.fallback}>
          <Text style={styles.errTitle}>Couldn't load</Text>
          <Text style={styles.errBody}>{err}</Text>
          <Pressable style={styles.cta} onPress={load}>
            <Text style={styles.ctaText}>Try again</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (!tx) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Header onBack={() => router.back()} />
        <View style={styles.fallback}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const money = formatMoney(tx.amount, tx.currency);
  const isSplit = tx.allocations.length > 1;
  const merchant = tx.merchantNormalized || tx.merchantRaw || "—";
  const firstAlloc = tx.allocations[0];
  const firstCat = firstAlloc?.categoryId ? categories[firstAlloc.categoryId] : null;
  const heroMeta = categoryMeta(firstCat);
  const needsConfirm =
    !isSplit && !!firstAlloc?.needsConfirmation && !!firstCat;
  const isOther =
    !!firstCat && firstCat.name.trim().toLowerCase() === "other";
  const unmatchedRefund =
    tx.budgetImpact === "refund" && !tx.refundOfTransactionId && !tx.pending;

  async function confirmCategory() {
    if (!tx) return;
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) return;
      await apiFetch(
        `/workspaces/${wsId}/transactions/${tx.id}/confirm-category`,
        { method: "POST" },
      );
      load();
    } catch (e) {
      Alert.alert("Couldn't confirm", (e as { code?: string }).code ?? "Try again.");
    }
  }

  async function saveBudgetImpact(scope: "transaction" | "merchant") {
    if (!tx || savingBudgetImpact) return;
    const includedImpact = money.isIncome
      ? firstCat?.name.trim().toLowerCase() === "refund" ? "refund" : "income"
      : "expense";
    const next = tx.budgetImpact === "excluded" ? includedImpact : "excluded";
    setSavingBudgetImpact(true);
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) throw new Error("no_workspace");
      const updated = await apiFetch<{ transaction: { merchantExclusionActive: boolean } }>(
        `/workspaces/${wsId}/transactions/${tx.id}`,
        {
        method: "PATCH",
        body: JSON.stringify({ budgetImpact: next, budgetImpactScope: scope }),
        },
      );
      setTx({
        ...tx,
        budgetImpact: next,
        budgetImpactSource: "user",
        merchantExclusionActive: updated.transaction.merchantExclusionActive,
      });
    } catch (e) {
      Alert.alert("Couldn't update", (e as { code?: string }).code ?? "Try again.");
    } finally {
      setSavingBudgetImpact(false);
    }
  }

  function toggleBudgetImpact() {
    if (!tx || savingBudgetImpact) return;
    const excluded = tx.budgetImpact === "excluded";
    Alert.alert(
      excluded ? "Include in budget?" : "Exclude from budget?",
      excluded
        ? "Choose whether this applies only to this transaction or to future transactions from this merchant."
        : "Choose whether to exclude this transaction once or always exclude this merchant.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "This transaction only", onPress: () => void saveBudgetImpact("transaction") },
        {
          text: excluded ? "This merchant going forward" : "Always exclude merchant",
          style: excluded ? "default" : "destructive",
          onPress: () => void saveBudgetImpact("merchant"),
        },
      ],
    );
  }

  async function setBusinessUse(mode: "full" | "none", partialTotal?: number) {
    if (!tx || savingBusinessUse) return;
    setSavingBusinessUse(true);
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) throw new Error("no_workspace");
      await apiFetch(`/workspaces/${wsId}/transactions/${tx.id}/business-use`, {
        method: "PUT",
        body: JSON.stringify({
          expectedVersion: tx.version,
          allocations: tx.allocations.map((allocation) => {
            const allocationAbs = Math.abs(Number(allocation.amount));
            const txAbs = Math.abs(Number(tx.amount));
            return ({
            allocationId: allocation.id,
            categoryId: allocation.categoryId,
            amount: Number(allocation.amount),
            businessAmount: partialTotal === undefined ? (mode === "full" ? allocationAbs : 0) : Math.min(allocationAbs, partialTotal * allocationAbs / txAbs),
            receiptLineItemId: allocation.receiptLineItemId,
          }); }),
        }),
      });
      await load();
    } catch (e) {
      Alert.alert("Couldn't update business use", (e as { code?: string }).code ?? "The transaction may have changed.");
      await load();
    } finally { setSavingBusinessUse(false); }
  }

  function setPartialBusinessUse() {
    if (!tx) return;
    Alert.prompt("Partial business amount", `Enter an amount up to ${formatMoney(Math.abs(Number(tx.amount)).toFixed(2), tx.currency).display}.`, (value) => {
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount < 0 || amount > Math.abs(Number(tx.amount))) {
        Alert.alert("Invalid amount", "Enter a business amount within the transaction total.");
        return;
      }
      setBusinessUse("none", amount);
    }, "plain-text", "", "decimal-pad");
  }

  async function uploadReceipt(role: ReceiptRole, source: ReceiptSource) {
    if (!tx) return;
    setUploadingReceipt(true);
    try {
      const receiptId = await pickAndUploadReceipt({ role, source, transactionId: tx.id });
      if (receiptId) router.push(`/receipts/${receiptId}` as never);
    } catch (e) {
      Alert.alert("Couldn't upload receipt", (e as { code?: string; message?: string }).code ?? (e as Error).message);
    } finally { setUploadingReceipt(false); }
  }

  function chooseReceiptSource(role: ReceiptRole) {
    Alert.alert("Add receipt", "Choose a source.", [
      { text: "Camera", onPress: () => uploadReceipt(role, "camera") },
      { text: "Photo Library", onPress: () => uploadReceipt(role, "library") },
      { text: "Files", onPress: () => uploadReceipt(role, "files") },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  function addReceipt() {
    Alert.alert("What does this document show?", "Choose both when one receipt includes item detail and the paid total.", [
      { text: "Itemized + payment", onPress: () => chooseReceiptSource("combined") },
      { text: "Itemized receipt", onPress: () => chooseReceiptSource("itemized") },
      { text: "Payment proof", onPress: () => chooseReceiptSource("payment_proof") },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  async function documentMissingEvidence(reason: string) {
    if (!tx) return;
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) throw new Error("no_workspace");
      await apiFetch(`/workspaces/${wsId}/transactions/${tx.id}/business-use`, {
        method: "PUT",
        body: JSON.stringify({
          expectedVersion: tx.version,
          allocations: tx.allocations.map((allocation) => ({
            categoryId: allocation.categoryId,
            amount: Number(allocation.amount),
            businessAmount: allocation.businessAmount === null ? null : Number(allocation.businessAmount),
            receiptLineItemId: allocation.receiptLineItemId,
          })),
          receiptMissingReason: reason,
        }),
      });
      await load();
    } catch (e) { Alert.alert("Couldn't save", (e as { code?: string }).code ?? "Try again."); }
  }

  function chooseMissingReason() {
    Alert.alert("Document missing evidence", "The expense stays marked Documented missing; this does not make it Evidence complete.", [
      { text: "Merchant didn't provide", onPress: () => documentMissingEvidence("merchant_did_not_provide") },
      { text: "Lost or unavailable", onPress: () => documentMissingEvidence("lost_or_unavailable") },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Header onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Hero */}
        <View style={styles.hero}>
          <View style={styles.heroTop}>
            <View style={[styles.heroGlyph, { backgroundColor: heroMeta.bg }]}>
              <Ionicons name={heroMeta.icon} size={22} color={heroMeta.fg} />
            </View>
            <Text style={styles.heroTitle} numberOfLines={2}>
              {merchant}
            </Text>
          </View>
          <Text style={[styles.heroAmount, money.isIncome && styles.incomeAmount]}>
            {money.isIncome ? "+" : "−"}{money.display}
          </Text>
          <View style={styles.heroMetaRow}>
            <Text style={styles.heroMeta}>{formatDateTime(tx.occurredAt)}</Text>
            {isSplit && (
              <>
                <View style={styles.heroDot} />
                <View style={styles.splitPill}>
                  <Text style={styles.splitPillText}>
                    SPLIT · {tx.allocations.length}
                  </Text>
                </View>
              </>
            )}
          </View>
        </View>

        {unmatchedRefund && (
          <View style={[styles.confirmBanner, styles.refundBanner]}>
            <Text style={styles.confirmBannerTitle}>Refund needs review</Text>
            <Text style={styles.confirmBannerSub}>
              We couldn't confidently match this refund to a purchase. It is
              not counted as income or applied to spending.
            </Text>
          </View>
        )}

        {/* Confirm-category banner — above Details so it's the first thing
            the user sees after the hero. */}
        {needsConfirm && (
          <View
            style={[
              styles.confirmBanner,
              isOther && styles.confirmBannerOther,
            ]}
          >
            <Text style={styles.confirmBannerTitle}>
              {isOther
                ? "Category review · Is Other right?"
                : `Category review · Is ${firstCat?.name} right?`}
            </Text>
            <Text style={styles.confirmBannerSub}>{merchant}</Text>
            {canEditWorkspace && <View style={styles.confirmBannerActions}>
              <Pressable
                style={({ pressed }) => [
                  styles.confirmBtn,
                  styles.confirmBtnPrimary,
                  pressed && { opacity: 0.7 },
                ]}
                onPress={confirmCategory}
              >
                <Text style={styles.confirmBtnPrimaryText}>Confirm</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.confirmBtn,
                  styles.confirmBtnGhost,
                  pressed && { opacity: 0.7 },
                ]}
                onPress={() => setPickerOpen(true)}
              >
                <Text style={styles.confirmBtnGhostText}>Change category</Text>
              </Pressable>
            </View>}
          </View>
        )}

        {/* Details */}
        <Text style={styles.groupLabel}>Details</Text>
        <View style={styles.group}>
          <DetailRow
            label="Amount"
            editable={canEditWorkspace && tx.source === "manual"}
            onPress={() =>
              router.push(`/transactions/${tx.id}/edit-amount` as never)
            }
          >
            <Text style={[styles.rowValue, money.isIncome && styles.incomeAmount]}>
              {money.isIncome ? "+" : "−"}{money.display}
            </Text>
          </DetailRow>
          <DetailRow
            label="Date"
            editable={canEditWorkspace && tx.source === "manual"}
            onPress={() => setDatePickerOpen(true)}
          >
            <Text style={styles.rowValue}>{formatDateTime(tx.occurredAt)}</Text>
          </DetailRow>
          <DetailRow
            label="Account"
            editable={canEditWorkspace && tx.source === "manual"}
            onPress={() => setAccountPickerOpen(true)}
          >
            <Text style={styles.rowValue}>{accountLabel(account)}</Text>
          </DetailRow>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Status</Text>
            <View style={styles.statusValue}>
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: tx.pending ? colors.muted : colors.up },
                ]}
              />
              <Text style={styles.rowValue}>
                {tx.pending ? "Pending" : "Posted"}
              </Text>
            </View>
          </View>
          {isSplit && tx.merchantRaw !== merchant && (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Merchant</Text>
              <Text style={styles.rowValue} numberOfLines={1}>
                {tx.merchantRaw}
              </Text>
            </View>
          )}
        </View>

        {isBusiness && <>
          <Text style={styles.groupLabel}>Business use</Text>
          <View style={styles.group}>
            <View style={styles.businessSummary}>
              <View><Text style={styles.catName}>{tx.allocations.some((a) => a.businessAmount === null) ? "Expense review" : `${formatMoney(tx.allocations.reduce((sum, a) => sum + Number(a.businessAmount ?? 0), 0).toFixed(2), tx.currency).display} business`}</Text><Text style={styles.catMeta}>Full, none, partial, or itemized</Text></View>
              {tx.allocations.every((a) => a.businessAmount !== null) && tx.allocations.some((a) => Number(a.businessAmount) > 0 && Number(a.businessAmount) < Math.abs(Number(a.amount))) && <View style={styles.splitPill}><Text style={styles.splitPillText}>PARTIAL</Text></View>}
            </View>
            {canEditBusiness && <View style={styles.businessButtons}><Pressable disabled={savingBusinessUse} style={styles.businessButton} onPress={() => setBusinessUse("full")}><Text style={styles.businessButtonText}>Full business</Text></Pressable><Pressable disabled={savingBusinessUse} style={styles.businessButton} onPress={setPartialBusinessUse}><Text style={styles.businessButtonText}>Partial</Text></Pressable><Pressable disabled={savingBusinessUse} style={styles.businessButton} onPress={() => setBusinessUse("none")}><Text style={styles.businessButtonText}>Not business</Text></Pressable></View>}
          </View>
          <Text style={styles.groupLabel}>Receipts & evidence</Text>
          <View style={styles.group}>
            {receipts.map((receipt) => <Pressable key={receipt.id} style={styles.receiptRow} onPress={() => router.push(`/receipts/${receipt.id}` as never)}><Ionicons name="document-text-outline" size={19} color={colors.primary} /><View style={{ flex: 1 }}><Text style={styles.catName}>{receipt.originalName}</Text><Text style={styles.catMeta}>{receipt.role.replaceAll("_", " ")} · {receipt.status.replaceAll("_", " ")}</Text></View><Ionicons name="chevron-forward" size={16} color={colors.mutedSoft} /></Pressable>)}
            {canEditBusiness && <><Pressable style={styles.receiptRow} disabled={uploadingReceipt} onPress={addReceipt}>{uploadingReceipt ? <ActivityIndicator color={colors.primary} /> : <Ionicons name="add-circle-outline" size={20} color={colors.primary} />}<Text style={[styles.catName, { color: colors.primary }]}>{uploadingReceipt ? "Uploading…" : "Add receipt"}</Text></Pressable>
            <Pressable style={styles.receiptRow} onPress={chooseMissingReason}><Ionicons name="alert-circle-outline" size={20} color={colors.muted} /><View style={{ flex: 1 }}><Text style={styles.catName}>Document missing evidence</Text><Text style={styles.catMeta}>{tx.receiptMissingReason ? "Reason saved · not Evidence complete" : "Record why a receipt is unavailable"}</Text></View></Pressable></>}
          </View>
        </>}

        {!isBusiness && <><Text style={styles.groupLabel}>Budget</Text>
        <View style={styles.group}>
          <DetailRow
            label="Budget"
            editable={canEditWorkspace && !savingBudgetImpact}
            onPress={toggleBudgetImpact}
          >
            <Text style={styles.rowValue}>
              {tx.budgetImpact === "excluded"
                ? tx.merchantExclusionActive ? "Always excluded" : "Excluded once"
                : "Included"}
            </Text>
          </DetailRow>
        </View>
        </>}

        {/* Category */}
        {!isSplit ? (
          <>
            <Text style={styles.groupLabel}>Category</Text>
            <View style={styles.group}>
              <Pressable
                disabled={!canEditWorkspace}
                style={({ pressed }) => [
                  styles.catRow,
                  pressed && { opacity: 0.6 },
                ]}
                onPress={() => setPickerOpen(true)}
              >
                <View style={[styles.catGlyph, { backgroundColor: heroMeta.bg }]}>
                  <Ionicons name={heroMeta.icon} size={16} color={heroMeta.fg} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.catName}>
                    {firstCat?.name ?? "Uncategorized"}
                  </Text>
                  <Text style={styles.catMeta}>
                    All {money.display} in one category
                  </Text>
                </View>
                {canEditWorkspace && <Text style={styles.changeLink}>Change</Text>}
              </Pressable>
              {canEditWorkspace && <Pressable
                style={({ pressed }) => [
                  styles.splitCta,
                  pressed && { opacity: 0.6 },
                ]}
                onPress={() =>
                  Alert.alert(
                    "Coming soon",
                    "Splitting a transaction across categories is on the way.",
                  )
                }
              >
                <View style={styles.splitCtaGlyph}>
                  <Ionicons name="pricetags-outline" size={14} color={colors.muted} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.splitCtaTitle}>
                    Split across multiple categories
                  </Text>
                  <Text style={styles.splitCtaSub}>
                    e.g. some groceries, some household items
                  </Text>
                </View>
                <Ionicons
                  name="chevron-forward"
                  size={16}
                  color={colors.mutedSoft}
                />
              </Pressable>}
            </View>
          </>
        ) : (
          <>
            <View style={styles.groupLabelRow}>
              <Text style={styles.groupLabel}>Categories</Text>
              <Text style={styles.groupLabelMeta}>
                Split across {tx.allocations.length}
              </Text>
            </View>
            <View style={styles.group}>
              {tx.allocations.map((a) => {
                const c = a.categoryId ? categories[a.categoryId] : null;
                const m = formatMoney(a.amount, tx.currency);
                const am = categoryMeta(c);
                return (
                  <View key={a.id} style={styles.allocRow}>
                    <View style={[styles.catGlyph, { backgroundColor: am.bg }]}>
                      <Ionicons name={am.icon} size={14} color={am.fg} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.catName}>
                        {c?.name ?? "Uncategorized"}
                      </Text>
                    </View>
                    <Text style={[styles.allocAmount, m.isIncome && styles.incomeAmount]}>
                      {m.isIncome ? "+" : "−"}{m.display}
                    </Text>
                  </View>
                );
              })}
              {canEditWorkspace && <Pressable
                style={({ pressed }) => [
                  styles.splitCta,
                  pressed && { opacity: 0.6 },
                ]}
                onPress={() =>
                  Alert.alert(
                    "Coming soon",
                    "Editing splits is on the way.",
                  )
                }
              >
                <View style={[styles.splitCtaGlyph, { backgroundColor: colors.surfaceSoft }]}>
                  <Ionicons name="create-outline" size={14} color={colors.muted} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.splitCtaTitle}>Edit split</Text>
                  <Text style={styles.splitCtaSub}>
                    Adjust categories or amounts
                  </Text>
                </View>
                <Ionicons
                  name="chevron-forward"
                  size={16}
                  color={colors.mutedSoft}
                />
              </Pressable>}
            </View>
          </>
        )}

        {/* Note */}
        <Text style={styles.groupLabel}>Note</Text>
        <View style={styles.group}>
          <Pressable
            disabled={!canEditWorkspace}
            style={({ pressed }) => [
              styles.noteRow,
              pressed && { opacity: 0.6 },
            ]}
            onPress={() => router.push(`/transactions/${tx.id}/note` as never)}
          >
            <Text
              style={[
                styles.noteText,
                !tx.note && { color: colors.mutedSoft },
              ]}
            >
              {tx.note ?? "Add a note"}
            </Text>
          </Pressable>
        </View>

        {/* Delete */}
        {canEditWorkspace && <View style={{ paddingHorizontal: space.base, paddingTop: space.lg, paddingBottom: space.xl }}>
          <Pressable
            style={({ pressed }) => [
              styles.deleteBtn,
              pressed && { opacity: 0.6 },
            ]}
            onPress={onDelete}
          >
            <Text style={styles.deleteText}>Delete transaction</Text>
          </Pressable>
        </View>}
      </ScrollView>

      <DatePickerSheet
        visible={datePickerOpen}
        value={new Date(tx.occurredAt)}
        mode="datetime"
        onClose={() => setDatePickerOpen(false)}
        onConfirm={async (next) => {
          setDatePickerOpen(false);
          try {
            const wsId = await getActiveWorkspaceId();
            if (!wsId) throw new Error("no_workspace");
            await apiFetch(`/workspaces/${wsId}/transactions/${tx.id}`, {
              method: "PATCH",
              body: JSON.stringify({ occurredAt: next.toISOString() }),
            });
            setTx({ ...tx, occurredAt: next.toISOString() });
          } catch (e) {
            Alert.alert(
              "Couldn't update date",
              (e as { code?: string }).code ?? "Try again.",
            );
          }
        }}
      />

      <AccountPickerSheet
        visible={accountPickerOpen}
        txId={tx.id}
        selectedId={tx.accountId}
        onClose={() => setAccountPickerOpen(false)}
        onChange={() => {
          setAccountPickerOpen(false);
          load();
        }}
      />

      <CategoryPickerSheet
        visible={pickerOpen}
        txId={tx.id}
        selectedId={firstAlloc?.categoryId ?? null}
        categoryType={money.isIncome ? "income" : "expense"}
        onClose={() => setPickerOpen(false)}
        onChange={() => {
          setPickerOpen(false);
          load();
        }}
      />

    </SafeAreaView>
  );
}

function DetailRow({
  label,
  editable,
  onPress,
  children,
}: {
  label: string;
  editable: boolean;
  onPress?: () => void;
  children: ReactNode;
}) {
  if (editable && onPress) {
    return (
      <Pressable
        style={({ pressed }) => [
          styles.row,
          pressed && { backgroundColor: colors.surfaceSoft },
        ]}
        onPress={onPress}
      >
        <Text style={styles.rowLabel}>{label}</Text>
        <View style={styles.rowValueWrap}>
          {children}
          <Ionicons
            name="chevron-forward"
            size={16}
            color={colors.mutedSoft}
          />
        </View>
      </Pressable>
    );
  }
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {children}
    </View>
  );
}

function Header({ onBack }: { onBack: () => void }) {
  return (
    <View style={styles.nav}>
      <HeaderIconButton icon="chevron-back" accessibilityLabel="Back" onPress={onBack} variant="plain" />
      <Text style={styles.navTitle}>Transaction</Text>
      <View style={{ width: 34 }} />
    </View>
  );
}

function accountLabel(a: BankAccountDTO | null): string {
  if (!a) return "—";
  const name = a.name || a.officialName || "Account";
  return a.mask ? `${name} ··${a.mask}` : name;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date} · ${time}`;
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
  navTitle: { ...type$.titleSm, color: colors.ink },
  scroll: { paddingBottom: space.xl },
  fallback: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
  errTitle: { ...type$.titleMd, color: colors.down, marginBottom: 4 },
  errBody: { ...type$.bodyMd, color: colors.body, marginBottom: space.base },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: space.xl,
    paddingVertical: 14,
    borderRadius: 999,
  },
  ctaText: { ...type$.button, color: colors.onPrimary },

  // Hero
  hero: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xl },
  heroTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm + 2,
    marginBottom: space.base,
  },
  heroGlyph: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  heroTitle: { ...type$.titleMd, color: colors.ink, flex: 1, flexShrink: 1 },
  heroAmount: {
    fontSize: 38,
    lineHeight: 38,
    fontWeight: "500",
    letterSpacing: -1.4,
    color: colors.ink,
    marginTop: 4,
  },
  incomeAmount: { color: colors.up },
  heroMetaRow: { flexDirection: "row", alignItems: "center", marginTop: 6, gap: 6 },
  heroMeta: { ...type$.bodySm, color: colors.muted },
  heroDot: { width: 3, height: 3, borderRadius: 999, backgroundColor: colors.mutedSoft },
  splitPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: colors.surfaceStrong,
  },
  splitPillText: {
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 0.4,
    color: colors.muted,
  },

  // Confirm-category banner — matches `group` width/radius/bg so it sits
  // flush with the other cards; the borderLeft is the only color signal.
  confirmBanner: {
    marginHorizontal: space.base,
    marginTop: space.lg,
    padding: space.base,
    borderRadius: 16,
    backgroundColor: colors.surfaceSoft,
    borderLeftWidth: 3,
    borderLeftColor: colors.accentYellow,
    gap: 6,
  },
  confirmBannerOther: {
    borderLeftColor: colors.down,
  },
  refundBanner: {
    borderLeftColor: colors.accentYellow,
  },
  confirmBannerTitle: { ...type$.titleSm, color: colors.ink },
  confirmBannerSub: { ...type$.bodySm, color: colors.muted },
  confirmBannerActions: {
    flexDirection: "row",
    gap: space.sm,
    marginTop: space.sm,
  },
  confirmBtn: {
    flex: 1,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
  },
  confirmBtnPrimary: { backgroundColor: colors.primary },
  confirmBtnPrimaryText: {
    ...type$.bodySm,
    color: colors.onPrimary,
    fontWeight: "600",
  },
  confirmBtnGhost: {
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.canvas,
  },
  confirmBtnGhostText: {
    ...type$.bodySm,
    color: colors.ink,
    fontWeight: "600",
  },

  // Group label
  groupLabel: {
    ...type$.bodySm,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xs,
    fontWeight: "600",
  },
  groupLabelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  groupLabelMeta: {
    ...type$.bodySm,
    color: colors.muted,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xs,
  },
  group: {
    marginHorizontal: space.base,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 16,
    overflow: "hidden",
  },

  // Row
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.base,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  rowLabel: { ...type$.bodyMd, color: colors.ink },
  rowValue: { ...type$.bodyMd, color: colors.muted, flexShrink: 1, marginLeft: space.sm, textAlign: "right" },
  rowValueWrap: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 },
  statusValue: { flexDirection: "row", alignItems: "center", gap: 6 },
  statusDot: { width: 6, height: 6, borderRadius: 999 },

  // Category
  catRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: space.base,
    gap: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  catGlyph: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: colors.canvas,
    alignItems: "center",
    justifyContent: "center",
  },
  catName: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  catMeta: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  changeLink: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },

  // Split CTA
  splitCta: {
    flexDirection: "row",
    alignItems: "center",
    padding: space.base,
    gap: space.sm,
  },
  splitCtaGlyph: {
    width: 28,
    height: 28,
    borderRadius: 999,
    backgroundColor: colors.canvas,
    alignItems: "center",
    justifyContent: "center",
  },
  splitCtaTitle: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  splitCtaSub: { ...type$.bodySm, color: colors.muted, marginTop: 1 },

  // Allocation row (split mode)
  allocRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: space.base,
    gap: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  allocAmount: { ...type$.bodyMd, color: colors.ink, fontWeight: "600", fontVariant: ["tabular-nums"] },

  businessSummary: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: space.base },
  businessButtons: { flexDirection: "row", gap: 8, paddingHorizontal: space.base, paddingBottom: space.base },
  businessButton: { flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: 10, backgroundColor: colors.canvas, borderWidth: 1, borderColor: colors.hairline },
  businessButtonText: { ...type$.bodySm, color: colors.ink, fontWeight: "600" },
  receiptRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: space.base, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline },

  // Note
  noteRow: { padding: space.base + 2 },
  noteText: { ...type$.bodyMd, color: colors.body },

  // Delete
  deleteBtn: {
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  deleteText: { ...type$.button, color: colors.down },
});
