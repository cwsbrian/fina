import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { BankAccountDTO, CategoryDTO, ReceiptDocumentDTO, TransactionDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspaceSummary } from "../../src/api/client";
import { formatMoney } from "../../src/format/money";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { CategoryPickerSheet } from "../../src/categories/CategoryPickerSheet";

type Selection = Record<string, { selected: boolean; businessAmount: string; categoryId?: string; categoryName?: string }>;

function allocatedLineAmounts(receipt: ReceiptDocumentDTO, transaction?: TransactionDTO | null): Map<string, string> {
  if (!transaction) return new Map(receipt.lineItems.map((line) => [line.id, line.lineTotal]));
  const items = receipt.lineItems.map((line) => ({ id: line.id, cents: Math.round(Number(line.lineTotal) * 100) })).filter((line) => line.cents > 0);
  const subtotal = items.reduce((sum, line) => sum + line.cents, 0);
  const transactionCents = Math.round(Math.abs(Number(transaction.amount)) * 100);
  if (!subtotal || !transactionCents) return new Map();
  const calculated = items.map((line) => { const exact = line.cents * transactionCents / subtotal; return { ...line, allocated: Math.floor(exact), fraction: exact - Math.floor(exact) }; });
  let remainder = transactionCents - calculated.reduce((sum, line) => sum + line.allocated, 0);
  calculated.sort((a, b) => b.fraction - a.fraction || a.id.localeCompare(b.id));
  for (let index = 0; index < calculated.length && remainder > 0; index += 1, remainder -= 1) calculated[index]!.allocated += 1;
  return new Map(calculated.map((line) => [line.id, (line.allocated / 100).toFixed(2)]));
}

function initialSelection(receipt: ReceiptDocumentDTO, transaction?: TransactionDTO | null): Selection {
  const allocated = allocatedLineAmounts(receipt, transaction);
  return Object.fromEntries(receipt.lineItems.map((line) => [line.id, {
    selected: true, businessAmount: allocated.get(line.id) ?? "0.00", ...(line.categoryId ? { categoryId: line.categoryId } : {}),
  }]));
}

export default function ReceiptReview() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [receipt, setReceipt] = useState<ReceiptDocumentDTO | null>(null);
  const [transaction, setTransaction] = useState<TransactionDTO | null>(null);
  const [matches, setMatches] = useState<TransactionDTO[]>([]);
  const [selection, setSelection] = useState<Selection>({});
  const [category, setCategory] = useState<CategoryDTO | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [categoryTarget, setCategoryTarget] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [currency, setCurrency] = useState("CAD");
  const [canEdit, setCanEdit] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [receiptDateText, setReceiptDateText] = useState("");

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const workspace = await bootstrapActiveWorkspaceSummary();
      if (!workspace) return;
      setWorkspaceId(workspace.id); setCurrency(workspace.currency);
      setCanEdit(workspace.role !== "viewer");
      const detail = await apiFetch<{ receipt: ReceiptDocumentDTO; downloadUrl: string }>(`/workspaces/${workspace.id}/receipts/${id}`);
      setReceipt(detail.receipt);
      setReceiptDateText(detail.receipt.receiptDate?.slice(0, 10) ?? "");
      setDownloadUrl(detail.downloadUrl);
      setSelection((current) => Object.keys(current).length ? current : initialSelection(detail.receipt));
      if (detail.receipt.transactionId) {
        const tx = await apiFetch<{ transaction: TransactionDTO }>(`/workspaces/${workspace.id}/transactions/${detail.receipt.transactionId}`);
        setTransaction(tx.transaction); setMatches([]);
        setSelection(initialSelection(detail.receipt, tx.transaction));
      } else if (detail.receipt.totalAmount || detail.receipt.receiptDate || detail.receipt.merchantName) {
        const list = await apiFetch<{ transactions: TransactionDTO[] }>(`/workspaces/${workspace.id}/transactions?limit=50&budgetImpact=expense`);
        const targetDate = detail.receipt.receiptDate?.slice(0, 10);
        const targetAmount = Number(detail.receipt.totalAmount);
        const merchant = detail.receipt.merchantName?.toLowerCase();
        setMatches(list.transactions.map((tx) => ({ tx, score: (targetDate && tx.occurredAt.slice(0, 10) === targetDate ? 3 : 0) + (Number.isFinite(targetAmount) && Math.abs(Math.abs(Number(tx.amount)) - targetAmount) < 0.01 ? 4 : 0) + (merchant && (tx.merchantNormalized ?? tx.merchantRaw).toLowerCase().includes(merchant) ? 2 : 0) })).filter((x) => x.score > 0).sort((a,b) => b.score-a.score).slice(0,3).map((x) => x.tx));
      }
      setError(null);
    } catch (e) { setError((e as { code?: string }).code ?? "load_error"); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!receipt || !["queued", "processing", "uploading"].includes(receipt.status)) return;
    const timer = setInterval(load, 2500); return () => clearInterval(timer);
  }, [load, receipt]);

  const selectedItems = useMemo(() => receipt?.lineItems.filter((line) => selection[line.id]?.selected) ?? [], [receipt, selection]);
  const link = async (tx: TransactionDTO) => {
    if (!workspaceId || !receipt) return;
    await apiFetch(`/workspaces/${workspaceId}/receipts/${receipt.id}/link`, { method: "POST", body: JSON.stringify({ transactionId: tx.id }) });
    setTransaction(tx); setMatches([]); setReceipt({ ...receipt, transactionId: tx.id }); setSelection(initialSelection(receipt, tx));
  };
  const createTransaction = async () => {
    if (!workspaceId || !receipt) return;
    try {
      const accounts = await apiFetch<{ accounts: BankAccountDTO[] }>(`/workspaces/${workspaceId}/accounts`);
      const manual = accounts.accounts.find((a) => !a.plaidItemId) ?? accounts.accounts[0];
      if (!manual) throw new Error("manual_account_required");
      const created = await apiFetch<{ transaction: TransactionDTO }>(`/workspaces/${workspaceId}/receipts/${receipt.id}/create-transaction`, { method: "POST", body: JSON.stringify({ accountId: manual.id }) });
      setTransaction(created.transaction); setReceipt({ ...receipt, transactionId: created.transaction.id }); setSelection(initialSelection(receipt, created.transaction));
    } catch (e) { Alert.alert("Couldn't create transaction", (e as { code?: string; message?: string }).code ?? (e as Error).message); }
  };
  const apply = async (mode: "whole" | "items") => {
    if (!workspaceId || !receipt || !transaction) return;
    if (mode === "whole" && !category) { setCategoryTarget(null); setPickerOpen(true); return; }
    if (mode === "items" && selectedItems.some((line) => !selection[line.id]?.categoryId && !category)) { setCategoryTarget(null); setPickerOpen(true); return; }
    setSaving(true);
    try {
      const body = mode === "whole" ? {
        mode, transactionId: transaction.id, expectedTransactionVersion: transaction.version, categoryId: category!.id,
      } : {
        mode, transactionId: transaction.id, expectedTransactionVersion: transaction.version,
        items: selectedItems.map((line) => ({ lineItemId: line.id, categoryId: selection[line.id]?.categoryId ?? category?.id ?? null, businessAmount: Number(selection[line.id]?.businessAmount ?? 0) })),
      };
      await apiFetch(`/workspaces/${workspaceId}/receipts/${receipt.id}/apply`, { method: "POST", body: JSON.stringify(body) });
      router.replace(`/transactions/${transaction.id}` as never);
    } catch (e) { Alert.alert("Couldn't apply expense", (e as { code?: string }).code ?? "Try again. The transaction may have changed."); await load(); }
    finally { setSaving(false); }
  };
  const reprocess = async () => {
    if (!workspaceId || !receipt) return;
    await apiFetch(`/workspaces/${workspaceId}/receipts/${receipt.id}/reprocess`, { method: "POST" }); load();
  };
  const saveCorrections = async () => {
    if (!workspaceId || !receipt) return;
    setSaving(true);
    try {
      const result = await apiFetch<{ receipt: ReceiptDocumentDTO }>(`/workspaces/${workspaceId}/receipts/${receipt.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          merchantName: receipt.merchantName,
          receiptDate: /^\d{4}-\d{2}-\d{2}$/.test(receiptDateText) ? `${receiptDateText}T00:00:00.000Z` : null,
          totalAmount: receipt.totalAmount === null ? null : Number(receipt.totalAmount),
          lineItems: receipt.lineItems.map((line) => ({
            id: line.id, description: line.description, quantity: line.quantity === null ? null : Number(line.quantity),
            unitPrice: line.unitPrice === null ? null : Number(line.unitPrice), lineTotal: Number(line.lineTotal), categoryId: line.categoryId,
          })),
        }),
      });
      setReceipt(result.receipt);
      setSelection(initialSelection(result.receipt, transaction));
    } catch (e) { Alert.alert("Couldn't save corrections", (e as { code?: string }).code ?? "Try again."); }
    finally { setSaving(false); }
  };

  if (!receipt) return <SafeAreaView style={styles.safe}><Stack.Screen options={{ headerShown: false }} /><View style={styles.center}>{error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={colors.primary} />}</View></SafeAreaView>;
  const processing = ["uploading", "queued", "processing"].includes(receipt.status);
  const mismatch = transaction && receipt.totalAmount && Math.abs(Math.abs(Number(transaction.amount)) - Number(receipt.totalAmount)) >= 0.01;
  const allocationPreview = allocatedLineAmounts(receipt, transaction);
  return <SafeAreaView style={styles.safe} edges={["top"]}><Stack.Screen options={{ headerShown: false }} />
    <View style={styles.nav}><Pressable onPress={() => router.back()}><Ionicons name="chevron-back" size={24} color={colors.ink} /></Pressable><Text style={styles.navTitle}>Receipt review</Text><View style={{ width: 24 }} /></View>
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.summary}><View style={{ flex: 1 }}>{canEdit ? <><TextInput style={styles.merchantInput} value={receipt.merchantName ?? ""} placeholder={receipt.originalName} onChangeText={(merchantName) => setReceipt({ ...receipt, merchantName })} /><TextInput style={styles.dateInput} value={receiptDateText} placeholder="YYYY-MM-DD" onChangeText={setReceiptDateText} /></> : <><Text style={styles.merchant}>{receipt.merchantName ?? receipt.originalName}</Text><Text style={styles.meta}>{receipt.receiptDate?.slice(0,10) ?? "Date not recognized"} · {receipt.role.replaceAll("_", " ")}</Text></>}</View>{canEdit ? <TextInput style={styles.totalInput} keyboardType="decimal-pad" value={receipt.totalAmount ?? ""} placeholder="Total" onChangeText={(totalAmount) => setReceipt({ ...receipt, totalAmount })} /> : <Text style={styles.total}>{receipt.totalAmount ? formatMoney(receipt.totalAmount, receipt.currency ?? currency).display : "—"}</Text>}</View>
      <View style={styles.documentActions}>{downloadUrl && <Pressable onPress={() => Linking.openURL(downloadUrl)}><Text style={styles.link}>View original</Text></Pressable>}{canEdit && !processing && <Pressable disabled={saving} onPress={saveCorrections}><Text style={styles.link}>Save OCR corrections</Text></Pressable>}</View>
      {processing && <View style={styles.notice}><ActivityIndicator color={colors.primary} /><View><Text style={styles.noticeTitle}>Reading your receipt</Text><Text style={styles.noticeBody}>OCR results will appear here. Nothing is applied automatically.</Text></View></View>}
      {receipt.status === "failed" && <View style={styles.notice}><View style={{ flex: 1 }}><Text style={styles.noticeTitle}>OCR couldn't finish</Text><Text style={styles.noticeBody}>You can retry or enter details manually.</Text></View><Pressable onPress={reprocess}><Text style={styles.link}>Retry</Text></Pressable></View>}
      {!processing && !transaction && <><Text style={styles.label}>LINK A TRANSACTION</Text><View style={styles.card}>{canEdit ? <>{matches.map((tx) => <Pressable key={tx.id} style={styles.match} onPress={() => link(tx)}><View style={{ flex: 1 }}><Text style={styles.itemTitle}>{tx.merchantNormalized ?? tx.merchantRaw}</Text><Text style={styles.meta}>{tx.occurredAt.slice(0,10)}</Text></View><Text style={styles.itemTitle}>{formatMoney(tx.amount, tx.currency).display}</Text></Pressable>)}<Pressable style={styles.action} onPress={createTransaction}><Text style={styles.actionText}>Create manual transaction from OCR</Text></Pressable><Pressable style={styles.later} onPress={() => router.back()}><Text style={styles.link}>Link later</Text></Pressable></> : <Text style={styles.readOnly}>Viewer access is read-only.</Text>}</View></>}
      {transaction && <><Text style={styles.label}>TRANSACTION</Text><View style={styles.card}><View style={styles.match}><View style={{ flex: 1 }}><Text style={styles.itemTitle}>{transaction.merchantNormalized ?? transaction.merchantRaw}</Text><Text style={styles.meta}>{transaction.occurredAt.slice(0,10)}</Text></View><Text style={styles.itemTitle}>{formatMoney(transaction.amount, transaction.currency).display}</Text></View>{mismatch && <Text style={styles.mismatch}>Receipt and transaction totals differ. The transaction will not be changed.</Text>}</View></>}
      {receipt.lineItems.length > 0 && <><View style={styles.sectionHead}><Text style={styles.label}>ITEMS · {selectedItems.length} SELECTED</Text>{canEdit && transaction && <Pressable onPress={() => { setCategoryTarget(null); setPickerOpen(true); }}><Text style={styles.link}>{category?.name ?? "Set all categories"}</Text></Pressable>}</View><View style={styles.card}>{receipt.lineItems.map((line) => { const state = selection[line.id] ?? { selected: false, businessAmount: "0" }; return <View key={line.id} style={styles.item}>{transaction && <Pressable disabled={!canEdit} onPress={() => setSelection((s) => ({ ...s, [line.id]: { ...state, selected: !state.selected, businessAmount: !state.selected ? allocationPreview.get(line.id) ?? line.lineTotal : "0" } }))}><Ionicons name={state.selected ? "checkbox" : "square-outline"} size={23} color={state.selected ? colors.primary : colors.muted} /></Pressable>}<View style={{ flex: 1 }}>{canEdit ? <TextInput style={styles.itemTitle} value={line.description} onChangeText={(description) => setReceipt({ ...receipt, lineItems: receipt.lineItems.map((candidate) => candidate.id === line.id ? { ...candidate, description } : candidate) })} /> : <Text style={styles.itemTitle}>{line.description}</Text>}{canEdit ? <TextInput style={styles.lineTotalInput} keyboardType="decimal-pad" value={line.lineTotal} onChangeText={(lineTotal) => setReceipt({ ...receipt, lineItems: receipt.lineItems.map((candidate) => candidate.id === line.id ? { ...candidate, lineTotal } : candidate) })} /> : <Text style={styles.meta}>Item total {formatMoney(line.lineTotal, currency).display}</Text>}{transaction && <Text style={styles.meta}>Allocated {formatMoney(allocationPreview.get(line.id) ?? "0", currency).display} incl. receipt-level difference</Text>}{canEdit && transaction && state.selected && <Pressable onPress={() => { setCategoryTarget(line.id); setPickerOpen(true); }}><Text style={styles.itemCategory}>{state.categoryName ?? category?.name ?? "Choose category"}</Text></Pressable>}</View>{canEdit && transaction && state.selected ? <TextInput style={styles.amountInput} keyboardType="decimal-pad" value={state.businessAmount} onChangeText={(value) => setSelection((s) => ({ ...s, [line.id]: { ...state, businessAmount: value } }))} /> : canEdit ? <Pressable onPress={() => setReceipt({ ...receipt, lineItems: receipt.lineItems.filter((candidate) => candidate.id !== line.id) })}><Ionicons name="trash-outline" size={18} color={colors.down} /></Pressable> : null}</View>})}</View></>}
      {canEdit && !processing && <Pressable style={styles.later} onPress={() => setReceipt({ ...receipt, lineItems: [...receipt.lineItems, { id: `new-${Date.now()}`, description: "New item", quantity: null, unitPrice: null, lineTotal: "0.00", confidence: null, page: 1, boundingBox: null, categoryId: null }] })}><Text style={styles.link}>Add item manually</Text></Pressable>}
      {canEdit && transaction && !processing && <View style={styles.actions}>{receipt.role !== "payment_proof" && receipt.lineItems.length > 0 && <Pressable style={styles.primary} disabled={saving || !selectedItems.length} onPress={() => apply("items")}><Text style={styles.primaryText}>{saving ? "Saving…" : "Expense selected items"}</Text></Pressable>}<Pressable style={styles.secondary} disabled={saving} onPress={() => apply("whole")}><Text style={styles.secondaryText}>Expense whole receipt</Text></Pressable><Text style={styles.disclaimer}>Evidence complete organizes records; it does not guarantee tax deductibility.</Text></View>}
    </ScrollView>
    <CategoryPickerSheet visible={pickerOpen} selectedId={categoryTarget ? selection[categoryTarget]?.categoryId ?? category?.id ?? null : category?.id ?? null} categoryType="expense" onClose={() => { setPickerOpen(false); setCategoryTarget(null); }} onSelect={(cat) => { if (categoryTarget) setSelection((current) => { const previous = current[categoryTarget] ?? { selected: true, businessAmount: "0" }; return { ...current, [categoryTarget]: cat ? { ...previous, categoryId: cat.id, categoryName: cat.name } : { selected: previous.selected, businessAmount: previous.businessAmount } }; }); else setCategory(cat); setPickerOpen(false); setCategoryTarget(null); }} />
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas }, center: { flex: 1, justifyContent: "center", alignItems: "center" }, nav: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: space.base, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline }, navTitle: { ...type$.titleSm, color: colors.ink }, content: { padding: space.base, paddingBottom: 60 }, summary: { flexDirection: "row", alignItems: "center", paddingVertical: space.base }, merchant: { ...type$.titleMd, color: colors.ink }, merchantInput: { ...type$.titleMd, color: colors.ink, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline }, dateInput: { ...type$.bodySm, color: colors.muted, marginTop: 5 }, totalInput: { ...type$.titleMd, color: colors.ink, width: 90, textAlign: "right" }, documentActions: { flexDirection: "row", justifyContent: "space-between", marginBottom: space.base }, meta: { ...type$.bodySm, color: colors.muted, marginTop: 3 }, total: { ...type$.titleMd, color: colors.ink }, label: { fontSize: 11, fontWeight: "700", letterSpacing: .8, color: colors.muted, marginTop: space.lg, marginBottom: 7 }, card: { backgroundColor: colors.surfaceSoft, borderRadius: 15, overflow: "hidden" }, notice: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.surfaceSoft, borderRadius: 15, padding: space.base }, noticeTitle: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" }, noticeBody: { ...type$.bodySm, color: colors.muted, marginTop: 2, flexShrink: 1 }, match: { flexDirection: "row", alignItems: "center", padding: space.base, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline }, action: { backgroundColor: colors.primary, margin: 10, padding: 12, borderRadius: 10, alignItems: "center" }, actionText: { ...type$.bodySm, color: colors.onPrimary, fontWeight: "700" }, later: { alignItems: "center", paddingVertical: 14 }, link: { ...type$.bodySm, color: colors.primary, fontWeight: "700" }, mismatch: { ...type$.bodySm, color: colors.down, padding: space.base }, readOnly: { ...type$.bodyMd, color: colors.muted, padding: space.lg, textAlign: "center" }, sectionHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" }, item: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline }, itemTitle: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" }, lineTotalInput: { ...type$.bodySm, color: colors.muted, marginTop: 3 }, itemCategory: { fontSize: 11, color: colors.primary, fontWeight: "700", marginTop: 4 }, amountInput: { width: 72, backgroundColor: colors.canvas, borderRadius: 8, padding: 8, textAlign: "right", color: colors.ink }, notBusiness: { fontSize: 11, color: colors.muted }, actions: { gap: 10, marginTop: space.lg }, primary: { backgroundColor: colors.primary, borderRadius: 12, alignItems: "center", padding: 14 }, primaryText: { ...type$.button, color: colors.onPrimary }, secondary: { borderWidth: 1, borderColor: colors.hairline, borderRadius: 12, alignItems: "center", padding: 14 }, secondaryText: { ...type$.button, color: colors.ink }, disclaimer: { ...type$.bodySm, color: colors.muted, textAlign: "center", paddingHorizontal: space.base }, error: { ...type$.bodyMd, color: colors.down },
});
