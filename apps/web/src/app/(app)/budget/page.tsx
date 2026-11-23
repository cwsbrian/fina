"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  BudgetPlanDTO,
  CategoryDTO,
  CurrentBudgetResponse,
  DefaultBudgetResponse,
  GoalDTO,
} from "@fina/shared";
import { apiFetch, useActiveWorkspaceId } from "../../../lib/api";
import { formatMoney } from "../../../lib/money";
import styles from "../finance.module.css";

type Scope = "month" | "default";
type SaveTarget = "month_only" | "default_only" | "both";
type Allocation = { categoryId: string; amount: string };
type Suggestion = { allocations: Array<{ categoryId: string; amount: number }>; notice?: string };

export default function BudgetPage() {
  const workspaceId = useActiveWorkspaceId();
  const [current, setCurrent] = useState<CurrentBudgetResponse | null>(null);
  const [defaultPlan, setDefaultPlan] = useState<BudgetPlanDTO | null>(null);
  const [recentAverage, setRecentAverage] = useState<number | null>(null);
  const [categories, setCategories] = useState<CategoryDTO[]>([]);
  const [goals, setGoals] = useState<GoalDTO[]>([]);
  const [scope, setScope] = useState<Scope>("month");
  const [editing, setEditing] = useState(false);
  const [total, setTotal] = useState("");
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [saveTarget, setSaveTarget] = useState<SaveTarget>("month_only");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const [currentResult, defaultResult, categoryResult, goalResult] = await Promise.all([
        apiFetch<CurrentBudgetResponse>(`/workspaces/${workspaceId}/budget-plans/current`),
        apiFetch<DefaultBudgetResponse>(`/workspaces/${workspaceId}/budget-plans/default`),
        apiFetch<{ categories: CategoryDTO[] }>(
          `/workspaces/${workspaceId}/categories?type=expense`,
        ),
        apiFetch<{ goals: GoalDTO[] }>(`/workspaces/${workspaceId}/goals`).catch(() => ({
          goals: [] as GoalDTO[],
        })),
      ]);
      setCurrent(currentResult);
      setDefaultPlan(defaultResult.plan);
      setRecentAverage(defaultResult.recentMonthlyAvgSpend);
      setCategories(categoryResult.categories.filter((category) => !category.archivedAt));
      setGoals(goalResult.goals);
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not load the budget.");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const plan = scope === "month" ? current?.plan : defaultPlan;
  useEffect(() => {
    if (editing) return;
    setTotal(plan ? Number(plan.totalAmount).toFixed(2) : "");
    setAllocations(
      plan?.categoryAllocations.map((allocation) => ({
        categoryId: allocation.categoryId,
        amount: allocation.amount.toFixed(2),
      })) ?? [],
    );
  }, [plan, editing]);

  const categoryById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories],
  );
  const spentById = useMemo(
    () => new Map(current?.spendByCategory.map((row) => [row.categoryId, row.spent]) ?? []),
    [current],
  );
  const scheduledById = useMemo(
    () => new Map(current?.scheduledByCategory.map((row) => [row.categoryId, row.spent]) ?? []),
    [current],
  );
  const goalByCategory = useMemo(() => {
    const result = new Map<string, Array<{ title: string; amount: number }>>();
    for (const goal of goals)
      for (const allocation of goal.allocations) {
        result.set(allocation.categoryId, [
          ...(result.get(allocation.categoryId) ?? []),
          { title: goal.title, amount: Number(allocation.monthlyAmount) },
        ]);
      }
    return result;
  }, [goals]);
  const rows = useMemo(() => {
    const ids = new Set([
      ...categories.map((category) => category.id),
      ...(current?.spendByCategory.map((row) => row.categoryId) ?? []),
      ...(current?.scheduledByCategory.map((row) => row.categoryId) ?? []),
      ...(current?.plan?.categoryAllocations.map((row) => row.categoryId) ?? []),
    ]);
    return [...ids]
      .map((id) => ({
        id,
        name:
          categoryById.get(id)?.name ??
          current?.spendByCategory.find((row) => row.categoryId === id)?.categoryName ??
          "Other",
        budget:
          current?.plan?.categoryAllocations.find((allocation) => allocation.categoryId === id)
            ?.amount ?? 0,
        spent: spentById.get(id) ?? 0,
        scheduled: scheduledById.get(id) ?? 0,
        goals: goalByCategory.get(id) ?? [],
      }))
      .filter((row) => row.budget > 0 || row.spent > 0 || row.scheduled > 0 || row.goals.length > 0)
      .sort((a, b) => b.spent - a.spent);
  }, [categories, categoryById, current, spentById, scheduledById, goalByCategory]);

  function changeScope(next: Scope) {
    setEditing(false);
    setScope(next);
    setSaveTarget(next === "month" ? "month_only" : "default_only");
  }

  function setAllocation(categoryId: string, amount: string) {
    setEditing(true);
    setAllocations((previous) => {
      const next = previous.filter((allocation) => allocation.categoryId !== categoryId);
      return amount ? [...next, { categoryId, amount }] : next;
    });
  }

  async function suggest() {
    if (!workspaceId || busy) return;
    const value = Number(total);
    if (!Number.isFinite(value) || value <= 0) {
      setError("Enter a total budget first.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiFetch<Suggestion>(
        `/workspaces/${workspaceId}/budget-plans/suggest-split`,
        {
          method: "POST",
          body: JSON.stringify({ totalAmount: value }),
        },
      );
      if (result.allocations.length) {
        setAllocations(
          result.allocations.map((allocation) => ({
            categoryId: allocation.categoryId,
            amount: allocation.amount.toFixed(2),
          })),
        );
        setEditing(true);
      } else
        setNotice(
          result.notice ?? "A category split is unavailable. You can still save the total.",
        );
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not suggest a split.");
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceId || !current || busy) return;
    const value = Number(total);
    if (!Number.isFinite(value) || value <= 0 || value > 9_999_999.99) {
      setError("Enter a budget above zero and below 10,000,000.");
      return;
    }
    const parsed = allocations
      .map((allocation) => ({
        categoryId: allocation.categoryId,
        amount: Number(allocation.amount),
      }))
      .filter((allocation) => allocation.amount > 0);
    if (
      allocations.some(
        (allocation) =>
          !Number.isFinite(Number(allocation.amount)) || Number(allocation.amount) < 0,
      )
    ) {
      setError("Category amounts must be zero or greater.");
      return;
    }
    if (parsed.reduce((sum, allocation) => sum + allocation.amount, 0) > value + 0.001) {
      setError("Category budgets cannot exceed the total budget.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = { totalAmount: value, categoryAllocations: parsed };
      if (!defaultPlan || saveTarget === "both") {
        await apiFetch(`/workspaces/${workspaceId}/budget-plans/default`, {
          method: "POST",
          body: JSON.stringify({ ...body, scope: "default_and_current" }),
        });
      } else if (saveTarget === "default_only") {
        await apiFetch(`/workspaces/${workspaceId}/budget-plans/default`, {
          method: "POST",
          body: JSON.stringify({ ...body, scope: "default_only" }),
        });
      } else {
        await apiFetch(`/workspaces/${workspaceId}/budget-plans/months/${current.yearMonth}`, {
          method: "POST",
          body: JSON.stringify(body),
        });
      }
      setEditing(false);
      setNotice("Budget saved.");
      await load();
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not save the budget.");
    } finally {
      setBusy(false);
    }
  }

  const currency = current?.currency ?? "CAD";
  const cap = Number(current?.plan?.totalAmount ?? 0);
  const spent = Number(current?.totalSpent ?? 0);
  const scheduled = Number(current?.totalScheduled ?? 0);
  const reserved = goals.reduce(
    (sum, goal) =>
      sum +
      goal.allocations.reduce(
        (subtotal, allocation) => subtotal + Number(allocation.monthlyAmount),
        0,
      ),
    0,
  );

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <div className={styles.eyebrow}>Spending plan</div>
          <h1 className={styles.title}>Budget</h1>
          <p className={styles.sub}>
            {current?.yearMonth ?? "This month"} spending and category limits.
          </p>
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
      {notice && (
        <div className={styles.panel} role="status" style={{ padding: 14, marginBottom: 16 }}>
          {notice}
        </div>
      )}
      {loading && !current && (
        <div className={`${styles.panel} ${styles.empty}`}>Loading budget…</div>
      )}
      {current && (
        <>
          <div className={styles.summaryGrid}>
            <div className={`${styles.panel} ${styles.summaryCard}`}>
              <div className={styles.summaryLabel}>Monthly budget</div>
              <div className={styles.summaryValue}>
                {current.plan ? formatMoney(cap, currency) : "Not set"}
              </div>
            </div>
            <div className={`${styles.panel} ${styles.summaryCard}`}>
              <div className={styles.summaryLabel}>Spent</div>
              <div className={styles.summaryValue}>{formatMoney(spent, currency)}</div>
            </div>
            <div className={`${styles.panel} ${styles.summaryCard}`}>
              <div className={styles.summaryLabel}>Remaining after scheduled</div>
              <div className={styles.summaryValue}>
                {current.plan ? formatMoney(cap - spent - scheduled, currency) : "—"}
              </div>
            </div>
          </div>
          <div className={styles.panel} style={{ padding: 20 }}>
            <div className={styles.progress}>
              <span style={{ width: `${cap > 0 ? Math.min(100, (spent / cap) * 100) : 0}%` }} />
            </div>
            <p className={styles.sub}>
              {formatMoney(scheduled, currency)} scheduled
              {reserved > 0 ? ` · ${formatMoney(reserved, currency)} reserved for goals` : ""}
            </p>
          </div>
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Categories</h2>
            <div className={`${styles.panel} ${styles.categoryRows}`}>
              {rows.length === 0 && (
                <div className={styles.empty}>No category spending or limits yet.</div>
              )}
              {rows.map((row) => (
                <div className={styles.categoryRow} key={row.id}>
                  <div>
                    <div className={styles.merchant}>{row.name}</div>
                    <div className={styles.muted}>
                      {row.scheduled > 0
                        ? `${formatMoney(row.scheduled, currency)} scheduled`
                        : row.budget
                          ? `${formatMoney(row.budget - row.spent - row.scheduled, currency)} left`
                          : "No cap set"}
                    </div>
                    {row.goals.map((goal, index) => (
                      <div className={styles.muted} key={`${goal.title}-${index}`}>
                        {goal.title}: {formatMoney(goal.amount, currency)}/mo
                      </div>
                    ))}
                  </div>
                  <div className={styles.barTrack}>
                    <div
                      className={styles.bar}
                      style={{
                        width: `${row.budget ? Math.min(100, (row.spent / row.budget) * 100) : 0}%`,
                      }}
                    />
                  </div>
                  <strong>
                    {formatMoney(row.spent, currency)}
                    {row.budget > 0 && (
                      <span className={styles.muted}> / {formatMoney(row.budget, currency)}</span>
                    )}
                  </strong>
                </div>
              ))}
            </div>
          </section>
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Edit budget</h2>
            <form className={styles.panel} onSubmit={save}>
              <div className={styles.formGrid}>
                <div className={styles.field}>
                  <label htmlFor="budget-scope">Edit</label>
                  <select
                    id="budget-scope"
                    className={styles.input}
                    value={scope}
                    onChange={(event) => changeScope(event.target.value as Scope)}
                  >
                    <option value="month">This month</option>
                    <option value="default">Default for future months</option>
                  </select>
                </div>
                <div className={styles.field}>
                  <label htmlFor="budget-total">Monthly total</label>
                  <input
                    id="budget-total"
                    className={styles.input}
                    type="number"
                    min="0.01"
                    max="9999999.99"
                    step="0.01"
                    value={total}
                    onChange={(event) => {
                      setTotal(event.target.value);
                      setEditing(true);
                    }}
                    required
                  />
                </div>
                <div className={styles.field}>
                  <label htmlFor="budget-save-target">Apply changes to</label>
                  <select
                    id="budget-save-target"
                    className={styles.input}
                    value={defaultPlan ? saveTarget : "both"}
                    onChange={(event) => setSaveTarget(event.target.value as SaveTarget)}
                    disabled={!defaultPlan}
                  >
                    {scope === "month" && <option value="month_only">This month only</option>}
                    {scope === "default" && (
                      <option value="default_only">Future months only</option>
                    )}
                    <option value="both">This month and future months</option>
                  </select>
                </div>
              </div>
              <div className={styles.budgetAllocations}>
                {categories.map((category) => (
                  <div className={styles.budgetAllocation} key={category.id}>
                    <label htmlFor={`budget-${category.id}`}>{category.name}</label>
                    <input
                      id={`budget-${category.id}`}
                      className={styles.input}
                      type="number"
                      min="0"
                      max="9999999.99"
                      step="0.01"
                      placeholder="0.00"
                      value={
                        allocations.find((allocation) => allocation.categoryId === category.id)
                          ?.amount ?? ""
                      }
                      onChange={(event) => setAllocation(category.id, event.target.value)}
                    />
                  </div>
                ))}
              </div>
              <div className={styles.budgetFooter}>
                <span className={styles.muted}>
                  Category total{" "}
                  {formatMoney(
                    allocations.reduce((sum, row) => sum + (Number(row.amount) || 0), 0),
                    currency,
                  )}
                  {recentAverage ? ` · Recent average ${formatMoney(recentAverage, currency)}` : ""}
                </span>
                <div className={styles.actions}>
                  <button
                    className={styles.buttonSecondary}
                    type="button"
                    onClick={() => void suggest()}
                    disabled={busy}
                  >
                    Suggest split
                  </button>
                  <button className={styles.button} type="submit" disabled={busy}>
                    {busy ? "Saving…" : "Save budget"}
                  </button>
                </div>
              </div>
            </form>
          </section>
        </>
      )}
    </div>
  );
}
