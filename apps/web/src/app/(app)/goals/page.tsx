"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  CreateGoalBody,
  PatchGoalBody,
  minDueDateOneMonthUTC,
  type GoalDTO,
  type WorkspaceSummary,
} from "@fina/shared";
import { apiFetch, useActiveWorkspaceId } from "../../../lib/api";
import { formatMoney } from "../../../lib/money";
import styles from "../finance.module.css";

const GOAL_ICONS = [
  "flag-outline",
  "airplane-outline",
  "home-outline",
  "car-outline",
  "school-outline",
  "gift-outline",
  "heart-outline",
  "cafe-outline",
  "fitness-outline",
  "book-outline",
  "musical-notes-outline",
  "game-controller-outline",
  "camera-outline",
];
const GOAL_SYMBOLS: Record<string, string> = {
  "flag-outline": "⚑",
  "airplane-outline": "✈",
  "home-outline": "⌂",
  "car-outline": "🚗",
  "school-outline": "🎓",
  "gift-outline": "🎁",
  "heart-outline": "♥",
  "cafe-outline": "☕",
  "fitness-outline": "◆",
  "book-outline": "📖",
  "musical-notes-outline": "♫",
  "game-controller-outline": "🎮",
  "camera-outline": "📷",
};

export default function GoalsPage() {
  const workspaceId = useActiveWorkspaceId();
  const [goals, setGoals] = useState<GoalDTO[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [currency, setCurrency] = useState("CAD");
  const [showArchived, setShowArchived] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [targetAmount, setTargetAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [icon, setIcon] = useState("flag-outline");
  const [color, setColor] = useState("#3eb38b");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const [result, workspaces] = await Promise.all([
        apiFetch<{ goals: GoalDTO[] }>(
          `/workspaces/${workspaceId}/goals${showArchived ? "?includeArchived=true" : ""}`,
        ),
        apiFetch<{ workspaces: WorkspaceSummary[] }>("/workspaces"),
      ]);
      setGoals(result.goals);
      setCurrency(
        workspaces.workspaces.find((workspace) => workspace.id === workspaceId)?.currency ?? "CAD",
      );
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not load goals");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, showArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = goals.find((goal) => goal.id === selectedId) ?? null;

  useEffect(() => {
    if (!workspaceId || !selectedId || selected?.strategy) return;
    let checks = 0;
    const timer = window.setInterval(() => {
      if (++checks > 10) {
        window.clearInterval(timer);
        return;
      }
      void apiFetch<{ goal: GoalDTO }>(`/workspaces/${workspaceId}/goals/${selectedId}`)
        .then(({ goal }) => {
          if (goal.strategy)
            setGoals((previous) => previous.map((item) => (item.id === goal.id ? goal : item)));
        })
        .catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [workspaceId, selectedId, selected?.strategy]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceId || busy) return;
    const parsed = CreateGoalBody.safeParse({
      title,
      description: description || null,
      targetAmount: Number(targetAmount),
      dueDate,
      icon,
      color,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the goal details.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ goal: GoalDTO }>(`/workspaces/${workspaceId}/goals`, {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      setShowCreate(false);
      setTitle("");
      setDescription("");
      setTargetAmount("");
      setDueDate("");
      setIcon("flag-outline");
      setColor("#3eb38b");
      await load();
      setSelectedId(result.goal.id);
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not create goal");
    } finally {
      setBusy(false);
    }
  }

  async function archive(goal: GoalDTO) {
    if (!workspaceId || busy) return;
    const parsed = PatchGoalBody.safeParse({ archived: !goal.archivedAt });
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/goals/${goal.id}`, {
        method: "PATCH",
        body: JSON.stringify(parsed.data),
      });
      setSelectedId(null);
      await load();
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not update goal");
    } finally {
      setBusy(false);
    }
  }

  async function regenerate(goal: GoalDTO) {
    if (!workspaceId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/goals/${goal.id}/strategy`, { method: "POST" });
      await load();
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not generate a plan");
    } finally {
      setBusy(false);
    }
  }

  async function remove(goal: GoalDTO) {
    if (!workspaceId || busy || !window.confirm(`Delete ${goal.title} permanently?`)) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/goals/${goal.id}`, { method: "DELETE" });
      setSelectedId(null);
      setEditing(false);
      await load();
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not delete goal");
    } finally {
      setBusy(false);
    }
  }

  async function editGoal(
    goal: GoalDTO,
    changes: {
      title: string;
      description: string;
      targetAmount: string;
      dueDate: string;
      icon: string;
      color: string;
    },
  ) {
    if (!workspaceId || busy) return;
    const parsed = PatchGoalBody.safeParse({
      title: changes.title,
      description: changes.description || null,
      targetAmount: Number(changes.targetAmount),
      dueDate: changes.dueDate,
      icon: changes.icon || null,
      color: changes.color || null,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the goal details.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/goals/${goal.id}`, {
        method: "PATCH",
        body: JSON.stringify(parsed.data),
      });
      setEditing(false);
      await load();
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not update goal");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>Goals</h1>
          <p className={styles.sub}>Track savings and the monthly plan behind each goal.</p>
        </div>
        <div className={styles.actions}>
          <button
            className={styles.buttonSecondary}
            type="button"
            onClick={() => setShowArchived((value) => !value)}
          >
            {showArchived ? "Hide archived" : "Show archived"}
          </button>
          <button
            className={styles.button}
            type="button"
            onClick={() => setShowCreate((value) => !value)}
          >
            {showCreate ? "Close form" : "+ New goal"}
          </button>
        </div>
      </div>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}

      {showCreate && (
        <form className={`${styles.panel} ${styles.panelGap}`} onSubmit={create}>
          <div className={styles.panelHead}>
            <h2 className={styles.panelTitle}>New goal</h2>
          </div>
          <div className={styles.formGrid}>
            <div className={styles.field}>
              <label htmlFor="goal-title">Goal</label>
              <input
                className={styles.input}
                id="goal-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Trip to Japan"
                required
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="goal-amount">Target amount</label>
              <input
                className={styles.input}
                id="goal-amount"
                value={targetAmount}
                onChange={(event) => setTargetAmount(event.target.value)}
                inputMode="decimal"
                required
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="goal-due">Target date</label>
              <input
                className={styles.input}
                id="goal-due"
                type="date"
                min={minDueDateOneMonthUTC().toISOString().slice(0, 10)}
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
                required
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="goal-icon">Icon</label>
              <select
                className={styles.input}
                id="goal-icon"
                value={icon}
                onChange={(event) => setIcon(event.target.value)}
              >
                {GOAL_ICONS.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice.replace("-outline", "").replaceAll("-", " ")}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="goal-color">Color</label>
              <input
                className={styles.input}
                id="goal-color"
                type="color"
                value={color}
                onChange={(event) => setColor(event.target.value)}
              />
            </div>
            <div className={`${styles.field} ${styles.fieldWide}`}>
              <label htmlFor="goal-description">Description</label>
              <input
                className={styles.input}
                id="goal-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className={styles.formActions}>
              <button className={styles.button} type="submit" disabled={busy}>
                {busy ? "Saving…" : "Create goal"}
              </button>
            </div>
          </div>
        </form>
      )}

      {loading && goals.length === 0 && (
        <div className={`${styles.panel} ${styles.empty}`}>Loading goals…</div>
      )}
      {!loading && goals.length === 0 && (
        <div className={`${styles.panel} ${styles.empty}`}>
          <span className={styles.emptyTitle}>No goals yet.</span>
          Create one to start planning.
        </div>
      )}
      <div className={styles.cards}>
        {goals.map((goal) => {
          const target = Number(goal.targetAmount);
          const saved = Number(goal.savedAmount);
          return (
            <button
              type="button"
              key={goal.id}
              className={`${styles.cardButton} ${selectedId === goal.id ? styles.cardSelected : ""}`}
              onClick={() => {
                setSelectedId(goal.id);
                setEditing(false);
              }}
            >
              <span className={styles.cardTitle}>
                <span
                  aria-hidden="true"
                  className={styles.goalGlyph}
                  style={{ color: goal.color ?? undefined }}
                >
                  {GOAL_SYMBOLS[goal.icon ?? "flag-outline"] ?? "⚑"}
                </span>
                {goal.title}
              </span>
              <span className={styles.cardMeta}>
                By {goal.dueDate}
                {goal.archivedAt ? " · Archived" : ""}
              </span>
              <span className={styles.progress}>
                <span
                  style={{
                    width: `${Math.min(100, target > 0 ? (saved / target) * 100 : 0)}%`,
                    background: goal.color ?? undefined,
                  }}
                />
              </span>
              <strong>
                {formatMoney(saved, currency)} of {formatMoney(target, currency)}
              </strong>
            </button>
          );
        })}
      </div>

      {selected && (
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>{selected.title}</h2>
            <div className={styles.actions}>
              <button
                className={styles.buttonSecondary}
                type="button"
                onClick={() => setEditing((value) => !value)}
              >
                {editing ? "Close editor" : "Edit"}
              </button>
              <button
                className={styles.buttonSecondary}
                type="button"
                disabled={busy}
                onClick={() => void regenerate(selected)}
              >
                Regenerate plan
              </button>
              <button
                className={styles.buttonSecondary}
                type="button"
                disabled={busy}
                onClick={() => void archive(selected)}
              >
                {selected.archivedAt ? "Restore" : "Archive"}
              </button>
              <button
                className={styles.buttonDanger}
                type="button"
                disabled={busy}
                onClick={() => void remove(selected)}
              >
                Delete
              </button>
            </div>
          </div>
          {editing && (
            <GoalEditor
              key={selected.id}
              goal={selected}
              currency={currency}
              busy={busy}
              onSave={(changes) => void editGoal(selected, changes)}
            />
          )}
          {selected.description && (
            <p className={styles.sectionNote}>{selected.description}</p>
          )}
          {selected.strategy?.notice && (
            <div className={styles.error}>{selected.strategy.notice}</div>
          )}
          <div className={styles.panel}>
            {selected.allocations.length === 0 ? (
              <div className={styles.empty}>The monthly savings plan is still being prepared.</div>
            ) : (
              <div className={styles.categoryRows}>
                {selected.allocations.map((allocation) => (
                  <div className={styles.categoryRow} key={allocation.categoryId}>
                    <span className={styles.merchant}>{allocation.categoryName}</span>
                    <span className={styles.muted}>
                      {allocation.rationale ?? "Monthly savings"}
                    </span>
                    <strong>{formatMoney(Number(allocation.monthlyAmount), currency)}/mo</strong>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function GoalEditor({
  goal,
  currency,
  busy,
  onSave,
}: {
  goal: GoalDTO;
  currency: string;
  busy: boolean;
  onSave: (changes: {
    title: string;
    description: string;
    targetAmount: string;
    dueDate: string;
    icon: string;
    color: string;
  }) => void;
}) {
  const [title, setTitle] = useState(goal.title);
  const [description, setDescription] = useState(goal.description ?? "");
  const [targetAmount, setTargetAmount] = useState(goal.targetAmount);
  const [dueDate, setDueDate] = useState(goal.dueDate);
  const [icon, setIcon] = useState(goal.icon ?? "flag-outline");
  const [color, setColor] = useState(goal.color ?? "#3eb38b");
  return (
    <form
      className={`${styles.panel} ${styles.panelGap}`}
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ title, description, targetAmount, dueDate, icon, color });
      }}
    >
      <div className={styles.formGrid}>
        <div className={styles.field}>
          <label htmlFor="goal-edit-title">Goal</label>
          <input
            className={styles.input}
            id="goal-edit-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="goal-edit-amount">Target ({currency})</label>
          <input
            className={styles.input}
            id="goal-edit-amount"
            type="number"
            min="0.01"
            step="0.01"
            value={targetAmount}
            onChange={(event) => setTargetAmount(event.target.value)}
            required
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="goal-edit-date">Target date</label>
          <input
            className={styles.input}
            id="goal-edit-date"
            type="date"
            min={minDueDateOneMonthUTC().toISOString().slice(0, 10)}
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
            required
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="goal-edit-icon">Icon</label>
          <select
            className={styles.input}
            id="goal-edit-icon"
            value={icon}
            onChange={(event) => setIcon(event.target.value)}
          >
            {GOAL_ICONS.map((choice) => (
              <option key={choice} value={choice}>
                {choice.replace("-outline", "").replaceAll("-", " ")}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor="goal-edit-color">Color</label>
          <input
            className={styles.input}
            id="goal-edit-color"
            type="color"
            value={color}
            onChange={(event) => setColor(event.target.value)}
          />
        </div>
        <div className={`${styles.field} ${styles.fieldWide}`}>
          <label htmlFor="goal-edit-description">Description</label>
          <input
            className={styles.input}
            id="goal-edit-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <div className={styles.formActions}>
          <button className={styles.button} type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save goal"}
          </button>
        </div>
      </div>
    </form>
  );
}
