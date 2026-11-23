"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { BankAccountDTO } from "@fina/shared";
import { apiFetch, useActiveWorkspaceId } from "../../../lib/api";
import styles from "../finance.module.css";

export default function AccountsPage() {
  const workspaceId = useActiveWorkspaceId();
  const [accounts, setAccounts] = useState<BankAccountDTO[]>([]);
  const [name, setName] = useState("");
  const [type, setType] = useState("depository");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      setAccounts(
        (
          await apiFetch<{ accounts: BankAccountDTO[] }>(
            `/workspaces/${workspaceId}/accounts?includeArchived=true`,
          )
        ).accounts,
      );
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not load accounts.");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceId || busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/accounts`, {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), type }),
      });
      setName("");
      await load();
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not create account.");
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, body: { name?: string; archived?: boolean }) {
    if (!workspaceId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setEditingId(null);
      await load();
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not update account.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <div className={styles.eyebrow}>Money sources</div>
          <h1 className={styles.title}>Accounts</h1>
          <p className={styles.sub}>
            Add manual accounts for transactions or manage existing ones.
          </p>
        </div>
        <a className={styles.buttonSecondary} href="/settings/banks">
          Manage bank connections
        </a>
      </div>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      <form className={styles.panel} onSubmit={create}>
        <div className={styles.formGrid}>
          <div className={styles.field}>
            <label htmlFor="account-name">Account name</label>
            <input
              className={styles.input}
              id="account-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              required
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="account-type">Type</label>
            <select
              className={styles.input}
              id="account-type"
              value={type}
              onChange={(event) => setType(event.target.value)}
            >
              <option value="depository">Bank or cash</option>
              <option value="credit">Credit</option>
              <option value="investment">Investment</option>
            </select>
          </div>
          <div className={styles.formActions}>
            <button className={styles.button} type="submit" disabled={busy}>
              Add account
            </button>
          </div>
        </div>
      </form>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Your accounts</h2>
        <div className={`${styles.panel} ${styles.categoryRows}`}>
          {accounts.map((account) => (
            <div className={styles.categoryManageRow} key={account.id}>
              {editingId === account.id ? (
                <form
                  className={styles.categoryEdit}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void patch(account.id, { name: editName.trim() });
                  }}
                >
                  <input
                    className={styles.input}
                    value={editName}
                    onChange={(event) => setEditName(event.target.value)}
                    required
                    maxLength={80}
                    aria-label="Account name"
                  />
                  <button className={styles.button} type="submit" disabled={busy}>
                    Save
                  </button>
                  <button
                    className={styles.buttonSecondary}
                    type="button"
                    onClick={() => setEditingId(null)}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <div>
                    <strong>{account.name}</strong>
                    <div className={styles.muted}>
                      {account.type} · {account.currency}
                      {account.archivedAt ? " · Archived" : ""}
                      {account.plaidAccountId ? " · Connected bank" : " · Manual"}
                    </div>
                  </div>
                  {!account.plaidAccountId && (
                    <div className={styles.actions}>
                      <button
                        className={styles.buttonSecondary}
                        type="button"
                        onClick={() => {
                          setEditingId(account.id);
                          setEditName(account.name);
                        }}
                      >
                        Rename
                      </button>
                      <button
                        className={styles.buttonSecondary}
                        type="button"
                        disabled={busy}
                        onClick={() => void patch(account.id, { archived: !account.archivedAt })}
                      >
                        {account.archivedAt ? "Restore" : "Archive"}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
          {loading && <div className={styles.empty}>Loading accounts…</div>}
          {!loading && accounts.length === 0 && (
            <div className={styles.empty}>No accounts yet.</div>
          )}
        </div>
      </section>
    </div>
  );
}
