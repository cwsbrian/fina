"use client";

import { useCallback, useEffect, useState } from "react";
import type { CategoryDTO, TransactionDTO, TransactionsResponse } from "@fina/shared";
import { apiFetch, useActiveWorkspaceId } from "../../../lib/api";
import { formatMoney } from "../../../lib/money";
import styles from "../finance.module.css";

export default function ReviewPage() {
  const workspaceId = useActiveWorkspaceId();
  const [rows, setRows] = useState<TransactionDTO[]>([]);
  const [categories, setCategories] = useState<CategoryDTO[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    async (cursor?: string) => {
      if (!workspaceId) return;
      setLoading(true);
      setError(null);
      try {
        const [list, cats] = await Promise.all([
          apiFetch<TransactionsResponse>(
            `/workspaces/${workspaceId}/transactions?needsReview=true&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          ),
          apiFetch<{ categories: CategoryDTO[] }>(`/workspaces/${workspaceId}/categories`),
        ]);
        setRows((previous) => (cursor ? [...previous, ...list.transactions] : list.transactions));
        setNextCursor(list.nextCursor);
        setCategories(cats.categories);
      } catch (cause) {
        setError((cause as { code?: string }).code ?? "Could not load category reviews.");
      } finally {
        setLoading(false);
      }
    },
    [workspaceId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function act(
    tx: TransactionDTO,
    kind: "confirm" | "snooze" | "change",
    categoryId?: string,
  ) {
    if (!workspaceId || busyId) return;
    setBusyId(tx.id);
    setError(null);
    try {
      if (kind === "change")
        await apiFetch(`/workspaces/${workspaceId}/transactions/${tx.id}`, {
          method: "PATCH",
          body: JSON.stringify({ categoryId: categoryId || null }),
        });
      else
        await apiFetch(
          `/workspaces/${workspaceId}/transactions/${tx.id}/${kind === "confirm" ? "confirm-category" : "snooze-category"}`,
          { method: "POST" },
        );
      await load();
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not update category.");
    } finally {
      setBusyId(null);
    }
  }

  const categoryById = new Map(categories.map((category) => [category.id, category.name]));
  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <div className={styles.eyebrow}>Inbox</div>
          <h1 className={styles.title}>Review categories</h1>
          <p className={styles.sub}>Confirm or correct Fina’s suggested transaction categories.</p>
        </div>
        <button
          className={styles.buttonSecondary}
          type="button"
          onClick={() => void load()}
          disabled={loading}
        >
          Refresh
        </button>
      </div>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      <div className={`${styles.panel} ${styles.categoryRows}`}>
        {rows.map((tx) => (
          <div className={styles.reviewRow} key={tx.id}>
            <div>
              <strong>{tx.merchantNormalized ?? tx.merchantRaw}</strong>
              <div className={styles.muted}>
                {new Date(tx.occurredAt).toLocaleDateString()} ·{" "}
                {formatMoney(Math.abs(Number(tx.amount)), tx.currency)}
              </div>
            </div>
            <div className={styles.actions}>
              <select
                className={styles.input}
                aria-label={`Category for ${tx.merchantRaw}`}
                value={tx.allocations.length === 1 ? (tx.allocations[0]?.categoryId ?? "") : ""}
                onChange={(event) => void act(tx, "change", event.target.value)}
                disabled={busyId !== null}
              >
                <option value="">Uncategorized</option>
                {categories
                  .filter(
                    (category) => category.type === (Number(tx.amount) < 0 ? "income" : "expense"),
                  )
                  .map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
              </select>
              <button
                className={styles.button}
                type="button"
                disabled={busyId !== null}
                onClick={() => void act(tx, "confirm")}
              >
                Confirm
              </button>
              <button
                className={styles.buttonSecondary}
                type="button"
                disabled={busyId !== null}
                onClick={() => void act(tx, "snooze")}
              >
                Later
              </button>
            </div>
            {tx.allocations.length > 1 && (
              <span className={styles.muted}>
                Split across{" "}
                {tx.allocations
                  .map(
                    (allocation) =>
                      categoryById.get(allocation.categoryId ?? "") ?? "Uncategorized",
                  )
                  .join(", ")}
              </span>
            )}
          </div>
        ))}
        {loading && <div className={styles.empty}>Loading reviews…</div>}
        {!loading && rows.length === 0 && <div className={styles.empty}>All caught up.</div>}
        {nextCursor && !loading && (
          <div className={styles.foot}>
            <button
              className={styles.buttonSecondary}
              type="button"
              onClick={() => void load(nextCursor)}
            >
              Load more
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
