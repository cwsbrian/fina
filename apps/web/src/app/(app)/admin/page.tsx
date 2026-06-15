"use client";

import { useEffect, useState } from "react";
import type { AdminUsersResponse } from "@fina/shared";
import { apiFetch } from "../../../lib/api";
import {
  adminErrorState,
  formatAdminDate,
  formatAdminSubscription,
  mergeAdminUsersPage,
} from "./admin-page-model";
import styles from "./admin.module.css";

export default function AdminPage() {
  const [data, setData] = useState<AdminUsersResponse | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
                  <div className={styles.primary}>{user.email}</div>
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
    </div>
  );
}
