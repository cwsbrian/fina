"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AMOUNT_RE,
  ManualTransactionBody,
  type BankAccountDTO,
  type CategoryDTO,
  type TransactionDTO,
  type TransactionsResponse,
} from "@fina/shared";
import { apiFetch, useActiveWorkspaceId } from "../../../lib/api";
import { formatMoney } from "../../../lib/money";
import styles from "../finance.module.css";

type Filters = {
  q: string;
  impact: "all" | TransactionDTO["budgetImpact"];
  accountId: string;
  categoryIds: string[];
  includeUncategorized: boolean;
  from: string;
  to: string;
};

const emptyFilters: Filters = {
  q: "",
  impact: "all",
  accountId: "",
  categoryIds: [],
  includeUncategorized: false,
  from: "",
  to: "",
};

function transactionsPath(workspaceId: string, filters: Filters, cursor: string | null): string {
  const query = new URLSearchParams({ limit: "50" });
  if (filters.q.trim()) query.set("q", filters.q.trim());
  if (filters.impact !== "all") query.set("budgetImpact", filters.impact);
  if (filters.accountId) query.set("accountId", filters.accountId);
  if (filters.categoryIds.length) query.set("categoryIds", filters.categoryIds.join(","));
  if (filters.includeUncategorized) query.set("uncategorizedOnly", "true");
  if (filters.from) query.set("from", `${filters.from}T00:00:00.000Z`);
  if (filters.to) query.set("to", `${filters.to}T23:59:59.999Z`);
  if (cursor) query.set("cursor", cursor);
  return `/workspaces/${workspaceId}/transactions?${query}`;
}

function dateLabel(value: string): string {
  return new Date(value).toLocaleDateString("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default function ActivityPage() {
  const workspaceId = useActiveWorkspaceId();
  const [draft, setDraft] = useState<Filters>(emptyFilters);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [rows, setRows] = useState<TransactionDTO[]>([]);
  const [categories, setCategories] = useState<CategoryDTO[]>([]);
  const [accounts, setAccounts] = useState<BankAccountDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<TransactionDTO | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [direction, setDirection] = useState<"expense" | "income">("expense");
  const [merchant, setMerchant] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [accountId, setAccountId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [editMerchant, setEditMerchant] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editAccountId, setEditAccountId] = useState("");
  const [editCategoryId, setEditCategoryId] = useState("");
  const [editImpact, setEditImpact] = useState<TransactionDTO["budgetImpact"]>("expense");
  const [editImpactScope, setEditImpactScope] = useState<"transaction" | "merchant">("transaction");
  const [busyDetail, setBusyDetail] = useState(false);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (!query.has("categoryId") && !query.has("from") && !query.has("to")) return;
    const next: Filters = {
      ...emptyFilters,
      categoryIds: query.get("categoryId") ? [query.get("categoryId")!] : [],
      includeUncategorized: query.get("uncategorizedOnly") === "true",
      from: query.get("from") ?? "",
      to: query.get("to") ?? "",
    };
    setDraft(next);
    setFilters(next);
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    const transactionId = new URLSearchParams(window.location.search).get("transaction");
    if (!transactionId) return;
    void apiFetch<{ transaction: TransactionDTO }>(
      `/workspaces/${workspaceId}/transactions/${transactionId}`,
    )
      .then((result) => selectTransaction(result.transaction))
      .catch((cause) =>
        setError((cause as { code?: string }).code ?? "Could not load transaction"),
      );
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    void Promise.all([
      apiFetch<{ categories: CategoryDTO[] }>(`/workspaces/${workspaceId}/categories`),
      apiFetch<{ accounts: BankAccountDTO[] }>(`/workspaces/${workspaceId}/accounts`),
    ])
      .then(([categoryData, accountData]) => {
        if (!active) return;
        setCategories(categoryData.categories);
        setAccounts(accountData.accounts);
      })
      .catch(() => {
        if (active) setError("Could not load categories or accounts");
      });
    return () => {
      active = false;
    };
  }, [workspaceId, reload]);

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    setLoading(true);
    setError(null);
    void apiFetch<TransactionsResponse>(transactionsPath(workspaceId, filters, cursor))
      .then((data) => {
        if (!active) return;
        setRows((current) => (cursor ? [...current, ...data.transactions] : data.transactions));
        setNextCursor(data.nextCursor);
      })
      .catch((cause) => {
        if (active) setError((cause as { code?: string }).code ?? "Could not load transactions");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspaceId, filters, cursor, reload]);

  const categoryById = useMemo(
    () => new Map(categories.map((category) => [category.id, category.name])),
    [categories],
  );
  const accountById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account.name])),
    [accounts],
  );
  const manualAccounts = useMemo(
    () =>
      accounts.filter(
        (account) => !account.plaidAccountId && !account.plaidItemId && !account.archivedAt,
      ),
    [accounts],
  );

  function selectTransaction(row: TransactionDTO) {
    setSelected(row);
    setEditMerchant(row.merchantRaw);
    setEditAmount(row.amount);
    setEditDate(row.occurredAt.slice(0, 10));
    setEditNote(row.note ?? "");
    setEditAccountId(row.accountId);
    setEditCategoryId(
      row.allocations.length === 1 ? (row.allocations[0]?.categoryId ?? "") : "__keep__",
    );
    setEditImpact(row.budgetImpact);
    setEditImpactScope("transaction");
  }

  async function updateDetail(
    body: Record<string, unknown>,
    method: "PATCH" | "POST" | "DELETE" = "PATCH",
    suffix = "",
  ) {
    if (!workspaceId || !selected || busyDetail) return;
    setBusyDetail(true);
    setError(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/transactions/${selected.id}${suffix}`, {
        method,
        ...(method === "PATCH" ? { body: JSON.stringify(body) } : {}),
      });
      if (method === "DELETE") setSelected(null);
      else {
        const result = await apiFetch<{ transaction: TransactionDTO }>(
          `/workspaces/${workspaceId}/transactions/${selected.id}`,
        );
        selectTransaction(result.transaction);
      }
      setRows([]);
      setCursor(null);
      setReload((value) => value + 1);
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not update transaction");
    } finally {
      setBusyDetail(false);
    }
  }

  function saveDetail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const body: Record<string, unknown> = {};
    if (selected.source === "manual") {
      const value = Number(editAmount);
      if (!Number.isFinite(value) || value === 0) {
        setError("Enter a nonzero amount.");
        return;
      }
      if (editMerchant.trim() !== selected.merchantRaw) body.merchantRaw = editMerchant.trim();
      if (value !== Number(selected.amount)) body.amount = value;
      if (editDate !== selected.occurredAt.slice(0, 10))
        body.occurredAt = `${editDate}T12:00:00.000Z`;
      if (editNote.trim() !== (selected.note ?? "")) body.note = editNote.trim() || null;
      if (editAccountId !== selected.accountId) body.accountId = editAccountId;
    }
    if (
      editCategoryId !== "__keep__" &&
      editCategoryId !==
        (selected.allocations.length === 1
          ? (selected.allocations[0]?.categoryId ?? "")
          : "__keep__")
    )
      body.categoryId = editCategoryId || null;
    if (editImpact !== selected.budgetImpact || editImpactScope === "merchant") {
      body.budgetImpact = editImpact;
      body.budgetImpactScope = editImpactScope;
    }
    if (Object.keys(body).length === 0) return;
    void updateDetail(body);
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRows([]);
    setNextCursor(null);
    setCursor(null);
    setFilters({ ...draft });
  }

  async function createTransaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceId || saving) return;
    if (!AMOUNT_RE.test(amount) || Number(amount) <= 0) {
      setError("Enter a valid amount with up to two decimal places.");
      return;
    }
    const parsed = ManualTransactionBody.safeParse({
      merchantRaw: merchant,
      amount: direction === "income" ? -Number(amount) : Number(amount),
      occurredAt: new Date(`${date}T12:00:00.000Z`).toISOString(),
      ...(accountId ? { accountId } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    if (!parsed.success) {
      setError("Check the transaction details and try again.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/transactions/manual`, {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      setShowCreate(false);
      setMerchant("");
      setAmount("");
      setNote("");
      setCategoryId("");
      setRows([]);
      setCursor(null);
      setReload((value) => value + 1);
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not save transaction");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <div className={styles.eyebrow}>Your money</div>
          <h1 className={styles.title}>Activity</h1>
          <p className={styles.sub}>Browse income, expenses, refunds, and excluded transactions.</p>
        </div>
        <div className={styles.actions}>
          <button
            className={styles.button}
            type="button"
            onClick={() => setShowCreate((value) => !value)}
          >
            {showCreate ? "Close form" : "+ Add transaction"}
          </button>
        </div>
      </div>

      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}

      {showCreate && (
        <form className={styles.panel} onSubmit={createTransaction} style={{ marginBottom: 20 }}>
          <div className={styles.formGrid}>
            <div className={styles.field}>
              <label htmlFor="tx-direction">Type</label>
              <select
                className={styles.input}
                id="tx-direction"
                value={direction}
                onChange={(event) => {
                  setDirection(event.target.value as "expense" | "income");
                  setCategoryId("");
                }}
              >
                <option value="expense">Expense</option>
                <option value="income">Income</option>
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="tx-amount">Amount</label>
              <input
                className={styles.input}
                id="tx-amount"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                required
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="tx-date">Date</label>
              <input
                className={styles.input}
                id="tx-date"
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                required
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="tx-merchant">Merchant or source</label>
              <input
                className={styles.input}
                id="tx-merchant"
                value={merchant}
                onChange={(event) => setMerchant(event.target.value)}
                required
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="tx-account">Account</label>
              <select
                className={styles.input}
                id="tx-account"
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
              >
                <option value="">Default account</option>
                {manualAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="tx-category">Category</label>
              <select
                className={styles.input}
                id="tx-category"
                value={categoryId}
                onChange={(event) => setCategoryId(event.target.value)}
              >
                <option value="">Uncategorized</option>
                {categories
                  .filter((category) => category.type === direction && !category.archivedAt)
                  .map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className={styles.field} style={{ gridColumn: "1 / -1" }}>
              <label htmlFor="tx-note">Note</label>
              <input
                className={styles.input}
                id="tx-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
            <div className={styles.formActions}>
              <button className={styles.button} type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save transaction"}
              </button>
              {manualAccounts.length === 0 && (
                <span className={styles.muted}>
                  Fina will use Cash by default. <a href="/accounts">Add another account</a>.
                </span>
              )}
            </div>
          </div>
        </form>
      )}

      <form className={`${styles.panel} ${styles.filters}`} onSubmit={applyFilters}>
        <div className={styles.field}>
          <label htmlFor="activity-search">Search</label>
          <input
            className={styles.input}
            id="activity-search"
            value={draft.q}
            onChange={(event) => setDraft({ ...draft, q: event.target.value })}
            placeholder="Merchant or source"
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="activity-type">Type</label>
          <select
            className={styles.input}
            id="activity-type"
            value={draft.impact}
            onChange={(event) =>
              setDraft({ ...draft, impact: event.target.value as Filters["impact"] })
            }
          >
            <option value="all">All activity</option>
            <option value="expense">Expenses</option>
            <option value="income">Income</option>
            <option value="refund">Refunds</option>
            <option value="excluded">Excluded</option>
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor="activity-category">Categories (multiple)</label>
          <select
            className={styles.input}
            id="activity-category"
            multiple
            size={3}
            value={draft.categoryIds}
            onChange={(event) =>
              setDraft({
                ...draft,
                categoryIds: Array.from(event.target.selectedOptions, (option) => option.value),
              })
            }
          >
            {categories
              .filter((category) => !category.archivedAt)
              .map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
          </select>
          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={draft.includeUncategorized}
              onChange={(event) =>
                setDraft({ ...draft, includeUncategorized: event.target.checked })
              }
            />
            Include uncategorized
          </label>
        </div>
        <div className={styles.field}>
          <label htmlFor="activity-account">Account</label>
          <select
            className={styles.input}
            id="activity-account"
            value={draft.accountId}
            onChange={(event) => setDraft({ ...draft, accountId: event.target.value })}
          >
            <option value="">All accounts</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor="activity-from">From</label>
          <input
            className={styles.input}
            id="activity-from"
            type="date"
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="activity-to">To</label>
          <input
            className={styles.input}
            id="activity-to"
            type="date"
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </div>
        <div className={styles.actions}>
          <button className={styles.buttonSecondary} type="submit">
            Apply
          </button>
          <button
            className={styles.buttonSecondary}
            type="button"
            onClick={() => {
              setDraft(emptyFilters);
              setFilters(emptyFilters);
              setCursor(null);
              setRows([]);
            }}
          >
            Reset
          </button>
        </div>
      </form>

      <div className={styles.panel} aria-busy={loading}>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Merchant</th>
                <th>Category</th>
                <th>Account</th>
                <th>Type</th>
                <th style={{ textAlign: "right" }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isIncome = Number(row.amount) < 0 && row.budgetImpact === "income";
                const netExpense = Math.max(0, Number(row.amount) - Number(row.refundedAmount));
                const categoryNames = [
                  ...new Set(
                    row.allocations
                      .map((allocation) =>
                        allocation.categoryId ? categoryById.get(allocation.categoryId) : null,
                      )
                      .filter(Boolean),
                  ),
                ];
                return (
                  <tr key={row.id}>
                    <td>{dateLabel(row.occurredAt)}</td>
                    <td>
                      <button
                        className={styles.rowButton}
                        type="button"
                        onClick={() => selectTransaction(row)}
                      >
                        <span className={styles.merchant}>
                          {row.merchantNormalized ?? row.merchantRaw}
                        </span>
                        {row.pending && <span className={styles.muted}> · Pending</span>}
                      </button>
                    </td>
                    <td>
                      {categoryNames.length ? (
                        categoryNames.join(", ")
                      ) : (
                        <span className={styles.muted}>Uncategorized</span>
                      )}
                    </td>
                    <td>{accountById.get(row.accountId) ?? "Archived account"}</td>
                    <td>
                      <span className={styles.pill}>{row.budgetImpact}</span>
                    </td>
                    <td
                      style={{ textAlign: "right" }}
                      className={isIncome ? styles.moneyIn : styles.moneyOut}
                    >
                      {formatMoney(
                        isIncome
                          ? Math.abs(Number(row.amount))
                          : row.budgetImpact === "expense"
                            ? netExpense
                            : Math.abs(Number(row.amount)),
                        row.currency,
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!loading && rows.length === 0 && (
          <div className={styles.empty}>No transactions match these filters.</div>
        )}
        {loading && <div className={styles.empty}>Loading transactions…</div>}
        {nextCursor && !loading && (
          <div className={styles.foot}>
            <button
              className={styles.buttonSecondary}
              type="button"
              onClick={() => setCursor(nextCursor)}
            >
              Load more
            </button>
          </div>
        )}
      </div>

      {selected && (
        <section className={styles.section}>
          <div className={styles.head} style={{ marginBottom: 12 }}>
            <h2 className={styles.sectionTitle} style={{ marginBottom: 0 }}>
              Transaction details
            </h2>
            <button
              className={styles.buttonSecondary}
              type="button"
              onClick={() => setSelected(null)}
            >
              Close
            </button>
          </div>
          {selected.budgetImpact === "refund" &&
            !selected.refundOfTransactionId &&
            !selected.pending && (
              <div className={styles.error}>
                Refund needs review. Fina could not match it to a purchase, so it is not counted as
                income or applied to spending.
              </div>
            )}
          <div className={`${styles.panel} ${styles.details}`}>
            <div className={styles.detail}>
              <span>Merchant</span>
              <span>{selected.merchantNormalized ?? selected.merchantRaw}</span>
            </div>
            <div className={styles.detail}>
              <span>Amount</span>
              <span>{formatMoney(Number(selected.amount), selected.currency)}</span>
            </div>
            <div className={styles.detail}>
              <span>Date</span>
              <span>{dateLabel(selected.occurredAt)}</span>
            </div>
            <div className={styles.detail}>
              <span>Account</span>
              <span>{accountById.get(selected.accountId) ?? "Archived account"}</span>
            </div>
            <div className={styles.detail}>
              <span>Cashflow</span>
              <span>{selected.budgetImpact}</span>
            </div>
            <div className={styles.detail}>
              <span>Note</span>
              <span>{selected.note || "No note"}</span>
            </div>
            {selected.refundOfTransactionId && (
              <div className={styles.detail}>
                <span>Refund for</span>
                <span>{selected.refundOfTransactionId}</span>
              </div>
            )}
            {Number(selected.refundedAmount) > 0 && (
              <div className={styles.detail}>
                <span>Refunded</span>
                <span>{formatMoney(Number(selected.refundedAmount), selected.currency)}</span>
              </div>
            )}
          </div>
          <form className={styles.panel} onSubmit={saveDetail} style={{ marginTop: 14 }}>
            <div className={styles.formGrid}>
              {selected.source === "manual" && (
                <>
                  <div className={styles.field}>
                    <label htmlFor="edit-merchant">Merchant</label>
                    <input
                      className={styles.input}
                      id="edit-merchant"
                      value={editMerchant}
                      onChange={(event) => setEditMerchant(event.target.value)}
                      required
                    />
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="edit-amount">Signed amount</label>
                    <input
                      className={styles.input}
                      id="edit-amount"
                      type="number"
                      step="0.01"
                      value={editAmount}
                      onChange={(event) => setEditAmount(event.target.value)}
                      required
                    />
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="edit-date">Date</label>
                    <input
                      className={styles.input}
                      id="edit-date"
                      type="date"
                      value={editDate}
                      onChange={(event) => setEditDate(event.target.value)}
                      required
                    />
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="edit-account">Account</label>
                    <select
                      className={styles.input}
                      id="edit-account"
                      value={editAccountId}
                      onChange={(event) => setEditAccountId(event.target.value)}
                    >
                      {manualAccounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="edit-note">Note</label>
                    <input
                      className={styles.input}
                      id="edit-note"
                      value={editNote}
                      onChange={(event) => setEditNote(event.target.value)}
                    />
                  </div>
                </>
              )}
              <div className={styles.field}>
                <label htmlFor="edit-category">Category</label>
                <select
                  className={styles.input}
                  id="edit-category"
                  value={editCategoryId}
                  onChange={(event) => setEditCategoryId(event.target.value)}
                >
                  {editCategoryId === "__keep__" && (
                    <option value="__keep__">Keep current split</option>
                  )}
                  <option value="">Uncategorized</option>
                  {categories
                    .filter(
                      (category) =>
                        category.type === (Number(selected.amount) < 0 ? "income" : "expense") &&
                        !category.archivedAt,
                    )
                    .map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                </select>
              </div>
              <div className={styles.field}>
                <label htmlFor="edit-impact">Cashflow</label>
                <select
                  className={styles.input}
                  id="edit-impact"
                  value={editImpact}
                  onChange={(event) =>
                    setEditImpact(event.target.value as TransactionDTO["budgetImpact"])
                  }
                >
                  <option value="expense">Expense</option>
                  <option value="income">Income</option>
                  <option value="refund">Refund</option>
                  <option value="excluded">Excluded</option>
                </select>
              </div>
              <div className={styles.field}>
                <label htmlFor="edit-impact-scope">Apply cashflow change to</label>
                <select
                  className={styles.input}
                  id="edit-impact-scope"
                  value={editImpactScope}
                  onChange={(event) =>
                    setEditImpactScope(event.target.value as "transaction" | "merchant")
                  }
                >
                  <option value="transaction">This transaction</option>
                  <option value="merchant">This merchant going forward</option>
                </select>
              </div>
              <div className={styles.formActions}>
                <button className={styles.button} type="submit" disabled={busyDetail}>
                  {busyDetail ? "Saving…" : "Save changes"}
                </button>
                {selected.allocations.some((allocation) => allocation.needsConfirmation) && (
                  <>
                    <button
                      className={styles.buttonSecondary}
                      type="button"
                      disabled={busyDetail}
                      onClick={() => void updateDetail({}, "POST", "/confirm-category")}
                    >
                      Confirm category
                    </button>
                    <button
                      className={styles.buttonSecondary}
                      type="button"
                      disabled={busyDetail}
                      onClick={() => void updateDetail({}, "POST", "/snooze-category")}
                    >
                      Remind in 7 days
                    </button>
                  </>
                )}
                {selected.source === "manual" && (
                  <button
                    className={styles.buttonSecondary}
                    type="button"
                    disabled={busyDetail}
                    onClick={() => {
                      if (window.confirm("Delete this transaction?"))
                        void updateDetail({}, "DELETE");
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
