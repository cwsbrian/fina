"use client";

import { useEffect, useState } from "react";
import type { AdminUserDetailDTO, AdminUsersResponse } from "@fina/shared";
import { apiFetch } from "../../../lib/api";
import {
  adminErrorState,
  formatAdminDateTime,
  formatAdminDevices,
  formatAdminDate,
  formatAdminSubscription,
  formatCad,
  mergeAdminUsersPage,
  usageSignal,
} from "./admin-page-model";
import styles from "./admin.module.css";

export default function AdminPage() {
  const [data, setData] = useState<AdminUsersResponse | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<AdminUserDetailDTO | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);

  const load = async (nextCursor: string | null = null) => {
    setLoading(true);
    setErr(null);
    try {
      const qs = nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : "";
      const page = await apiFetch<AdminUsersResponse>(`/admin/users${qs}`);
      const merged = mergeAdminUsersPage(data, page, Boolean(nextCursor));
      setData(merged);
      setCursor(merged.nextCursor);
    } catch (e) {
      const next = adminErrorState(e);
      setData(next.data);
      setCursor(next.cursor);
      setErr(next.err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const loadDetail = async (userId: string) => {
    setDetailLoadingId(userId);
    setDetailErr(null);
    try {
      setDetail(await apiFetch<AdminUserDetailDTO>(`/admin/users/${encodeURIComponent(userId)}`));
    } catch (e) {
      const next = adminErrorState(e);
      setDetailErr(next.err);
    } finally {
      setDetailLoadingId(null);
    }
  };

  if (err === "forbidden") {
    return (
      <div className={styles.container}>
        <h1 className={styles.title}>Admin</h1>
        <p className={styles.error}>You do not have access to this page.</p>
      </div>
    );
  }

  if (err) {
    return (
      <div className={styles.container}>
        <h1 className={styles.title}>Admin</h1>
        <p className={styles.error}>Could not load: {err}</p>
        <button className={styles.button} type="button" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }

  const users = data?.users ?? [];

  return (
    <div className={styles.container}>
      <div className={styles.head}>
        <h1 className={styles.title}>Admin</h1>
        <p className={styles.sub}>{users.length} users loaded</p>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Tier</th>
              <th>Device</th>
              <th>Subscription</th>
              <th>Active subs</th>
              <th>Mismatch</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  <button
                    className={styles.rowButton}
                    type="button"
                    onClick={() => void loadDetail(user.id)}
                  >
                    {user.email}
                  </button>
                  <div className={styles.muted}>{user.name ?? "No name"}</div>
                </td>
                <td>{user.role}</td>
                <td>
                  <div className={styles.primary}>{user.tier}</div>
                  <div className={styles.muted}>
                    {user.trial.active ? `Trial ends ${formatAdminDate(user.trial.endsAt)}` : "No active trial"}
                  </div>
                </td>
                <td>
                  <div className={styles.primary}>{formatAdminDevices(user)}</div>
                  <div className={styles.muted}>
                    {formatAdminDate(user.deviceSummary[0]?.lastSeenAt ?? null)}
                  </div>
                </td>
                <td>
                  <div className={styles.primary}>{formatAdminSubscription(user)}</div>
                  <div className={styles.muted}>{user.subscription?.environment ?? "No environment"}</div>
                </td>
                <td>{user.activeSubscriptionCount}</td>
                <td>
                  <span className={user.isPlanMismatch ? styles.badgeDanger : styles.badge}>
                    {user.isPlanMismatch ? "Mismatch" : "OK"}
                  </span>
                </td>
                <td>{formatAdminDate(user.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {cursor && (
        <button
          className={styles.button}
          type="button"
          disabled={loading}
          onClick={() => void load(cursor)}
        >
          {loading ? "Loading" : "Load more"}
        </button>
      )}

      {detailLoadingId && <p className={styles.sub}>Loading user detail...</p>}
      {detailErr && <p className={styles.error}>Could not load detail: {detailErr}</p>}
      {detail && (
        <section className={styles.detail}>
          <div className={styles.detailHead}>
            <div>
              <h2 className={styles.detailTitle}>{detail.user.email}</h2>
              <p className={styles.sub}>{usageSignal(detail)}</p>
            </div>
            <button className={styles.closeButton} type="button" onClick={() => setDetail(null)}>
              Close
            </button>
          </div>

          <div className={styles.detailGrid}>
            <div>
              <h3 className={styles.sectionTitle}>Activity</h3>
              <dl className={styles.kv}>
                <div><dt>Last seen</dt><dd>{formatAdminDateTime(detail.activity.lastSeenAt)}</dd></div>
                <div><dt>Last transaction</dt><dd>{formatAdminDateTime(detail.activity.lastTransactionAt)}</dd></div>
                <div><dt>Transactions</dt><dd>{detail.activity.transactionCount}</dd></div>
                <div><dt>Chat</dt><dd>{detail.activity.chatMessageCount} messages</dd></div>
              </dl>
            </div>

            <div>
              <h3 className={styles.sectionTitle}>AI Usage</h3>
              <dl className={styles.kv}>
                <div><dt>Total calls</dt><dd>{detail.aiUsage.total.callCount}</dd></div>
                <div><dt>Total tokens</dt><dd>{detail.aiUsage.total.inputTokens + detail.aiUsage.total.outputTokens}</dd></div>
                <div><dt>Total cost</dt><dd>{formatCad(detail.aiUsage.total.costCad)}</dd></div>
              </dl>
              <div className={styles.miniTableWrap}>
                <table className={styles.miniTable}>
                  <thead><tr><th>Month</th><th>Calls</th><th>Tokens</th><th>Cost</th></tr></thead>
                  <tbody>
                    {detail.aiUsage.monthly.map((month) => (
                      <tr key={month.month}>
                        <td>{month.month}</td>
                        <td>{month.callCount}</td>
                        <td>{month.inputTokens + month.outputTokens}</td>
                        <td>{formatCad(month.costCad)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className={styles.detailGrid}>
            <div>
              <h3 className={styles.sectionTitle}>Devices</h3>
              <ul className={styles.list}>
                {[...detail.devices, ...detail.sessions].map((device, index) => (
                  <li key={`${device.platform}-${index}`}>
                    <span className={styles.primary}>{device.platform}</span>
                    <span className={styles.muted}>{formatAdminDateTime("lastSeenAt" in device ? device.lastSeenAt : device.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className={styles.sectionTitle}>Plaid Accounts</h3>
              <ul className={styles.list}>
                {detail.plaidItems.flatMap((item) =>
                  item.accounts.length
                    ? item.accounts.map((account) => (
                        <li key={account.id}>
                          <span className={styles.primary}>{account.name}{account.mask ? ` - ${account.mask}` : ""}</span>
                          <span className={styles.muted}>{item.institutionName} - {item.status} - {account.type}{account.subtype ? `/${account.subtype}` : ""}</span>
                        </li>
                      ))
                    : [
                        <li key={item.id}>
                          <span className={styles.primary}>{item.institutionName}</span>
                          <span className={styles.muted}>{item.status} - no accounts</span>
                        </li>,
                      ],
                )}
              </ul>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
