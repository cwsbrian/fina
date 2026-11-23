"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PostScheduledSpendBody, type CategoryDTO, type ScheduledSpendDTO } from "@fina/shared";
import { apiFetch, useActiveWorkspaceId } from "../../../lib/api";
import { formatMoney } from "../../../lib/money";
import styles from "../finance.module.css";

export default function ScheduledPage() {
  const workspaceId = useActiveWorkspaceId();
  const [rows, setRows] = useState<ScheduledSpendDTO[]>([]);
  const [categories, setCategories] = useState<CategoryDTO[]>([]);
  const [currency, setCurrency] = useState("CAD");
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const [scheduleResult, categoryResult, budgetResult] = await Promise.all([
        apiFetch<{ schedules: ScheduledSpendDTO[] }>(
          `/workspaces/${workspaceId}/schedules?status=${status}`,
        ),
        apiFetch<{ categories: CategoryDTO[] }>(
          `/workspaces/${workspaceId}/categories?type=expense`,
        ),
        apiFetch<{ currency: string }>(`/workspaces/${workspaceId}/budget-plans/current`),
      ]);
      setRows(scheduleResult.schedules);
      setCategories(categoryResult.categories);
      setCurrency(budgetResult.currency);
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not load scheduled spending.");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, status]);
  useEffect(() => {
    void load();
  }, [load]);

  function edit(row: ScheduledSpendDTO) {
    setSelected(row.id);
    setCategoryId(row.categoryId);
    setAmount(row.amount);
    setDate(row.scheduledDate);
    setNote(row.note ?? "");
  }
  function reset() {
    setSelected(null);
    setCategoryId("");
    setAmount("");
    setDate("");
    setNote("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceId || busy) return;
    const parsed = PostScheduledSpendBody.safeParse({
      categoryId,
      amount: Number(amount),
      scheduledDate: date,
      note: note.trim(),
    });
    if (!parsed.success || Number(amount) <= 0) {
      setError("Check the planned spend details.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/schedules${selected ? `/${selected}` : ""}`, {
        method: selected ? "PATCH" : "POST",
        body: JSON.stringify(parsed.data),
      });
      reset();
      await load();
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not save scheduled spend.");
    } finally {
      setBusy(false);
    }
  }

  async function act(row: ScheduledSpendDTO, action: "dismiss" | "delete") {
    if (!workspaceId || busy) return;
    if (action === "delete" && !window.confirm("Delete this planned spend?")) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(
        `/workspaces/${workspaceId}/schedules/${row.id}${action === "dismiss" ? "/dismiss" : ""}`,
        { method: action === "dismiss" ? "POST" : "DELETE" },
      );
      if (selected === row.id) reset();
      await load();
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not update scheduled spend.");
    } finally {
      setBusy(false);
    }
  }

  const categoryName = new Map(categories.map((category) => [category.id, category.name]));
  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <div className={styles.eyebrow}>Upcoming money</div>
          <h1 className={styles.title}>Scheduled spending</h1>
          <p className={styles.sub}>Plan one-time expenses and resolve them after they happen.</p>
        </div>
        <div className={styles.field}>
          <label htmlFor="schedule-status">Show</label>
          <select
            className={styles.input}
            id="schedule-status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="all">All</option>
            <option value="upcoming">Upcoming</option>
            <option value="unresolved">Needs review</option>
            <option value="resolved-matched">Matched</option>
            <option value="resolved-dismissed">Dismissed</option>
          </select>
        </div>
      </div>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      <div className={styles.panel}>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Category</th>
                <th>Note</th>
                <th>Status</th>
                <th>Amount</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.scheduledDate}</td>
                  <td className={styles.merchant}>
                    {categoryName.get(row.categoryId) ?? "Category"}
                  </td>
                  <td>{row.note ?? "—"}</td>
                  <td>
                    <span className={styles.pill}>{row.status}</span>
                  </td>
                  <td>{formatMoney(Number(row.amount), currency)}</td>
                  <td>
                    <div className={styles.actions}>
                      {(row.status === "upcoming" || row.status === "unresolved") && (
                        <button
                          className={styles.buttonSecondary}
                          type="button"
                          onClick={() => edit(row)}
                        >
                          Edit
                        </button>
                      )}
                      {row.status === "unresolved" && (
                        <button
                          className={styles.buttonSecondary}
                          type="button"
                          disabled={busy}
                          onClick={() => void act(row, "dismiss")}
                        >
                          Dismiss
                        </button>
                      )}
                      <button
                        className={styles.buttonSecondary}
                        type="button"
                        disabled={busy}
                        onClick={() => void act(row, "delete")}
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
        {loading && <div className={styles.empty}>Loading planned spending…</div>}
        {!loading && rows.length === 0 && (
          <div className={styles.empty}>No planned spending in this view.</div>
        )}
      </div>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{selected ? "Edit planned spend" : "Plan a spend"}</h2>
        <form className={styles.panel} onSubmit={save}>
          <div className={styles.formGrid}>
            <div className={styles.field}>
              <label htmlFor="scheduled-category">Category</label>
              <select
                className={styles.input}
                id="scheduled-category"
                value={categoryId}
                onChange={(event) => setCategoryId(event.target.value)}
                required
              >
                <option value="">Choose a category</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="scheduled-amount">Amount</label>
              <input
                className={styles.input}
                id="scheduled-amount"
                type="number"
                min="0.01"
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                required
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="scheduled-date">Date</label>
              <input
                className={styles.input}
                id="scheduled-date"
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                required
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="scheduled-note">Note</label>
              <input
                className={styles.input}
                id="scheduled-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
            <div className={styles.formActions}>
              <button className={styles.button} type="submit" disabled={busy}>
                {busy ? "Saving…" : selected ? "Save changes" : "Add planned spend"}
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
