"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PostRecurringBody, type CategoryDTO, type RecurringExpenseDTO } from "@fina/shared";
import { apiFetch, useActiveWorkspaceId } from "../../../lib/api";
import { formatMoney } from "../../../lib/money";
import styles from "../finance.module.css";

export default function SubscriptionsPage() {
  const workspaceId = useActiveWorkspaceId();
  const [rows, setRows] = useState<RecurringExpenseDTO[]>([]);
  const [categories, setCategories] = useState<CategoryDTO[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState<RecurringExpenseDTO["cadence"]>("monthly");
  const [nextDate, setNextDate] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [merchant, setMerchant] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const [recurring, cats] = await Promise.all([
        apiFetch<{ recurring: RecurringExpenseDTO[] }>(`/workspaces/${workspaceId}/recurring`),
        apiFetch<{ categories: CategoryDTO[] }>(
          `/workspaces/${workspaceId}/categories?type=expense`,
        ),
      ]);
      setRows(recurring.recurring);
      setCategories(cats.categories);
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not load subscriptions.");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);
  useEffect(() => {
    void load();
  }, [load]);

  function edit(row: RecurringExpenseDTO) {
    setSelected(row.id);
    setName(row.name);
    setAmount(row.amount);
    setCadence(row.cadence);
    setNextDate(row.nextOccurrenceDate);
    setCategoryId(row.categoryId ?? "");
    setMerchant(row.merchantNormalized ?? "");
  }
  function reset() {
    setSelected(null);
    setName("");
    setAmount("");
    setCadence("monthly");
    setNextDate("");
    setCategoryId("");
    setMerchant("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceId || busy) return;
    const parsed = PostRecurringBody.safeParse({
      name,
      amount: Number(amount),
      cadence,
      nextOccurrenceDate: nextDate,
      ...(categoryId ? { categoryId } : {}),
      ...(merchant.trim() ? { merchant: merchant.trim() } : {}),
    });
    if (!parsed.success || Number(amount) <= 0) {
      setError("Check the subscription details.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/recurring${selected ? `/${selected}` : ""}`, {
        method: selected ? "PATCH" : "POST",
        body: JSON.stringify(parsed.data),
      });
      reset();
      await load();
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not save subscription.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: RecurringExpenseDTO) {
    if (!workspaceId || busy || !window.confirm(`Delete ${row.name}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/recurring/${row.id}`, { method: "DELETE" });
      if (selected === row.id) reset();
      await load();
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not delete subscription.");
    } finally {
      setBusy(false);
    }
  }

  const monthly = rows.reduce((sum, row) => sum + Number(row.monthlyEquivalent), 0);
  const currency = rows[0]?.currency ?? "CAD";
  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>Subscriptions</h1>
          <p className={styles.sub}>Track upcoming payments and their monthly cost.</p>
        </div>
      </div>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      <div className={`${styles.panel} ${styles.summaryCard} ${styles.panelGap}`}>
        <div className={styles.summaryLabel}>Monthly equivalent</div>
        <div className={styles.summaryValue}>{formatMoney(monthly, currency)}</div>
        <div className={styles.sub}>{rows.length} recurring expenses</div>
      </div>
      <div className={styles.panel}>
        <div className={styles.tableWrap}>
          <table className={`${styles.table} ${styles.stackTable}`} role="table">
            <thead role="rowgroup">
              <tr role="row">
                <th role="columnheader">Name</th>
                <th role="columnheader">Frequency</th>
                <th role="columnheader">Next payment</th>
                <th role="columnheader">Category</th>
                <th role="columnheader" className={styles.num}>
                  Amount
                </th>
                <th role="columnheader">Actions</th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {rows.map((row) => (
                <tr key={row.id} role="row">
                  <td role="cell" className={`${styles.merchant} ${styles.cellLead}`}>
                    {row.name}
                  </td>
                  <td role="cell" data-label="Frequency" className={styles.cellCap}>
                    {row.cadence}
                  </td>
                  <td role="cell" data-label="Next payment" className={styles.cellDate}>
                    {row.nextOccurrenceDate}
                  </td>
                  <td role="cell" data-label="Category">
                    {row.categoryName ?? "—"}
                  </td>
                  <td role="cell" data-label="Amount" className={styles.num}>
                    {formatMoney(Number(row.amount), row.currency)}
                  </td>
                  <td role="cell" className={styles.cellActions}>
                    <div className={styles.actions}>
                      <button
                        className={`${styles.buttonSecondary} ${styles.buttonSmall}`}
                        type="button"
                        onClick={() => edit(row)}
                      >
                        Edit
                      </button>
                      <button
                        className={`${styles.buttonDanger} ${styles.buttonSmall}`}
                        type="button"
                        disabled={busy}
                        onClick={() => void remove(row)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loading && <div className={styles.empty}>Loading subscriptions…</div>}
        {!loading && rows.length === 0 && (
          <div className={styles.empty}>
            <span className={styles.emptyTitle}>No subscriptions yet.</span>
            Add one below to see its monthly cost here.
          </div>
        )}
      </div>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>
          {selected ? "Edit subscription" : "Add subscription"}
        </h2>
        <form className={styles.panel} onSubmit={save}>
          <div className={styles.formGrid}>
            <div className={styles.field}>
              <label htmlFor="rec-name">Name</label>
              <input
                className={styles.input}
                id="rec-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={100}
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="rec-amount">Amount</label>
              <input
                className={styles.input}
                id="rec-amount"
                type="number"
                min="0.01"
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                required
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="rec-cadence">Frequency</label>
              <select
                className={styles.input}
                id="rec-cadence"
                value={cadence}
                onChange={(event) =>
                  setCadence(event.target.value as RecurringExpenseDTO["cadence"])
                }
              >
                <option value="monthly">Monthly</option>
                <option value="semimonthly">Twice monthly</option>
                <option value="biweekly">Every two weeks</option>
                <option value="weekly">Weekly</option>
                <option value="yearly">Yearly</option>
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="rec-date">Next payment</label>
              <input
                className={styles.input}
                id="rec-date"
                type="date"
                value={nextDate}
                onChange={(event) => setNextDate(event.target.value)}
                required
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="rec-category">Category</label>
              <select
                className={styles.input}
                id="rec-category"
                value={categoryId}
                onChange={(event) => setCategoryId(event.target.value)}
              >
                <option value="">No category</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="rec-merchant">Merchant match</label>
              <input
                className={styles.input}
                id="rec-merchant"
                value={merchant}
                onChange={(event) => setMerchant(event.target.value)}
              />
            </div>
            <div className={styles.formActions}>
              <button className={styles.button} type="submit" disabled={busy}>
                {busy ? "Saving…" : selected ? "Save changes" : "Add subscription"}
              </button>
              {selected && (
                <button className={styles.buttonSecondary} type="button" onClick={reset}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}
