"use client";

import { useCallback, useEffect, useState } from "react";
import type { AnalysisResponse, WorkspaceSummary } from "@fina/shared";
import { apiFetch, useActiveWorkspaceId } from "../../../lib/api";
import { formatMoney } from "../../../lib/money";
import styles from "../finance.module.css";

type Period = { year: number; month: number };

function adjacent({ year, month }: Period, offset: number): Period {
  const date = new Date(year, month - 1 + offset, 1);
  return { year: date.getFullYear(), month: date.getMonth() + 1 };
}

function isCurrentOrFuture(period: Period): boolean {
  const now = new Date();
  return (
    period.year > now.getFullYear() ||
    (period.year === now.getFullYear() && period.month >= now.getMonth() + 1)
  );
}

export default function AnalysisPage() {
  const workspaceId = useActiveWorkspaceId();
  const [period, setPeriod] = useState<Period | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [currency, setCurrency] = useState("CAD");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const path = period
        ? `/workspaces/${workspaceId}/analysis?year=${period.year}&month=${period.month}`
        : `/workspaces/${workspaceId}/analysis`;
      const [data, workspaces] = await Promise.all([
        apiFetch<AnalysisResponse>(path),
        apiFetch<{ workspaces: WorkspaceSummary[] }>("/workspaces"),
      ]);
      setAnalysis(data);
      setCurrency(workspaces.workspaces.find((item) => item.id === workspaceId)?.currency ?? "CAD");
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not load analysis");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, period]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = analysis?.current;
  const maxHistory = Math.max(
    1,
    ...(analysis?.monthlyHistory.flatMap((point) => [point.income, point.spend]) ?? []),
  );
  const maxCategory = Math.max(1, ...(current?.spendByCategory.map((row) => row.amount) ?? []));

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <div className={styles.eyebrow}>Your money</div>
          <h1 className={styles.title}>Analysis</h1>
          <p className={styles.sub}>Income, spending, and the categories behind them.</p>
        </div>
        <div className={styles.monthNav}>
          <button
            className={styles.buttonSecondary}
            type="button"
            aria-label="Previous month"
            onClick={() => current && setPeriod(adjacent(current, -1))}
            disabled={!current}
          >
            ←
          </button>
          <span className={styles.monthLabel}>{current?.label ?? "Loading…"}</span>
          <button
            className={styles.buttonSecondary}
            type="button"
            aria-label="Next month"
            onClick={() => current && setPeriod(adjacent(current, 1))}
            disabled={!current || isCurrentOrFuture(current)}
          >
            →
          </button>
        </div>
      </div>

      {error && (
        <div className={styles.error} role="alert">
          {error}{" "}
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {loading && !analysis && (
        <div className={`${styles.panel} ${styles.empty}`}>Loading analysis…</div>
      )}
      {current && (
        <>
          <div className={styles.summaryGrid} aria-busy={loading}>
            <div className={`${styles.panel} ${styles.summaryCard}`}>
              <div className={styles.summaryLabel}>Income</div>
              <div className={`${styles.summaryValue} ${styles.moneyIn}`}>
                {formatMoney(current.income, currency)}
              </div>
            </div>
            <div className={`${styles.panel} ${styles.summaryCard}`}>
              <div className={styles.summaryLabel}>Expenses</div>
              <div className={styles.summaryValue}>{formatMoney(current.spend, currency)}</div>
            </div>
            <div className={`${styles.panel} ${styles.summaryCard}`}>
              <div className={styles.summaryLabel}>Net</div>
              <div className={`${styles.summaryValue} ${current.net >= 0 ? styles.moneyIn : ""}`}>
                {formatMoney(current.net, currency)}
              </div>
            </div>
          </div>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Monthly history</h2>
            <div className={styles.panel}>
              <div className={styles.history}>
                {analysis?.monthlyHistory.map((point) => (
                  <div className={styles.historyItem} key={`${point.year}-${point.month}`}>
                    <div
                      className={styles.historyBars}
                      aria-label={`${point.label}: income ${formatMoney(point.income, currency)}, expenses ${formatMoney(point.spend, currency)}`}
                    >
                      <span
                        className={styles.historyIncome}
                        style={{ height: `${Math.max(2, (point.income / maxHistory) * 100)}%` }}
                      />
                      <span
                        className={styles.historySpend}
                        style={{ height: `${Math.max(2, (point.spend / maxHistory) * 100)}%` }}
                      />
                    </div>
                    <span className={styles.historyLabel}>{point.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Spending by category</h2>
            <div className={styles.panel}>
              {current.spendByCategory.length === 0 ? (
                <p className={styles.empty}>No categorized expenses for this month.</p>
              ) : (
                <div className={styles.categoryRows}>
                  {current.spendByCategory.map((row) => (
                    <div className={styles.categoryRow} key={row.categoryId}>
                      <a
                        className={styles.merchant}
                        href={`/activity?categoryId=${encodeURIComponent(row.categoryId)}&from=${current.year}-${String(current.month).padStart(2, "0")}-01&to=${new Date(Date.UTC(current.year, current.month, 0)).toISOString().slice(0, 10)}`}
                      >
                        {row.categoryName}
                      </a>
                      <div className={styles.barTrack}>
                        <div
                          className={styles.bar}
                          style={{
                            width: `${(row.amount / maxCategory) * 100}%`,
                            background: row.color ?? undefined,
                          }}
                        />
                      </div>
                      <strong className={styles.moneyOut}>
                        {formatMoney(row.amount, currency)}
                      </strong>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
