"use client";

import React, { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ChatMessageBody,
  isDueDateAtLeastOneMonth,
  minDueDateOneMonthUTC,
  type ChatMessageDTO,
  type ChatThreadDTO,
  type PresentationBlock,
} from "@fina/shared";
import { apiFetch } from "../lib/api";
import { formatMoney } from "../lib/money";
import styles from "../app/(app)/finance.module.css";

type ThreadResponse = {
  thread: ChatThreadDTO;
  messages: ChatMessageDTO[];
  nextCursor: string | null;
  resolvedIntentIds: string[];
};
type RecurringForm = Extract<PresentationBlock, { type: "recurring_form_card" }>;
type GoalForm = Extract<PresentationBlock, { type: "goal_form_card" }>;

function blocksOf(message: ChatMessageDTO): PresentationBlock[] {
  return Array.isArray(message.blocks) ? (message.blocks as PresentationBlock[]) : [];
}

function cardTitle(block: PresentationBlock): string {
  if ("title" in block && typeof block.title === "string") return block.title;
  if (block.type === "transaction_detail") return block.merchant;
  if (block.type === "goal_detail") return block.title;
  if (block.type === "goal_form_card" || block.type === "recurring_form_card")
    return block.question;
  if (block.type === "confirm_card" || block.type === "plan_proposal_card") return block.question;
  return block.type.replaceAll("_", " ");
}

function ChatBlock({
  block,
  resolved,
  busy,
  onIntent,
  onDismiss,
}: {
  block: PresentationBlock;
  resolved: Set<string>;
  busy: boolean;
  onIntent: (id: string, overrides?: Record<string, unknown>) => Promise<void>;
  onDismiss: (id: string) => void;
}) {
  if (block.type === "text") return <p className={styles.chatText}>{block.markdown}</p>;
  if (block.type === "goal_form_card")
    return (
      <GoalFormCard
        block={block}
        resolved={resolved.has(block.intent_id)}
        busy={busy}
        onIntent={onIntent}
        onDismiss={onDismiss}
      />
    );
  if (block.type === "recurring_form_card")
    return (
      <RecurringFormCard
        block={block}
        resolved={resolved.has(block.intent_id)}
        busy={busy}
        onIntent={onIntent}
        onDismiss={onDismiss}
      />
    );
  if (block.type === "confirm_card" || block.type === "plan_proposal_card")
    return (
      <div className={styles.chatCard}>
        <strong>{cardTitle(block)}</strong>
        {block.type === "plan_proposal_card" && (
          <div className={styles.chatRows}>
            {block.rows.map((row, index) => (
              <div key={index}>
                <span>
                  {row.category} · {row.date}
                </span>
                <strong>{row.amount}</strong>
              </div>
            ))}
          </div>
        )}
        {resolved.has(block.accept_intent) ? (
          <span className={styles.muted}>Completed or expired</span>
        ) : (
          <div className={styles.actions}>
            <button
              className={styles.button}
              type="button"
              disabled={busy}
              onClick={() => void onIntent(block.accept_intent)}
            >
              {block.accept_label}
            </button>
            <button
              className={styles.buttonSecondary}
              type="button"
              disabled={busy}
              onClick={() => {
                onDismiss(block.accept_intent);
                if (block.reject_intent) void onIntent(block.reject_intent);
              }}
            >
              {block.reject_label}
            </button>
          </div>
        )}
      </div>
    );
  if (block.type === "categorize_confirm_card")
    return (
      <div className={styles.chatCard}>
        <strong>Categories to review · {block.count}</strong>
        <div className={styles.chatRows}>
          {block.items.map((item) => (
            <div key={item.txId}>
              <span>{item.merchant}</span>
              <span>{item.categoryName}</span>
            </div>
          ))}
        </div>
        <a href="/review">Review categories</a>
      </div>
    );
  if (block.type === "scheduled_list")
    return (
      <div className={styles.chatCard}>
        <strong>{block.title}</strong>
        <div className={styles.chatRows}>
          {block.rows.map((row) => (
            <div key={row.id}>
              <span>
                {row.name}
                <small>
                  {row.scheduled_date} · {row.status}
                </small>
              </span>
              <strong>{row.amount}</strong>
              {row.dismiss_intent && !resolved.has(row.dismiss_intent) && (
                <button
                  className={styles.buttonSecondary}
                  type="button"
                  disabled={busy}
                  onClick={() => void onIntent(row.dismiss_intent!)}
                >
                  Dismiss
                </button>
              )}
            </div>
          ))}
        </div>
        <a href="/scheduled">See scheduled spending</a>
      </div>
    );
  if (block.type === "recurring_candidates")
    return (
      <div className={styles.chatCard}>
        <strong>{block.title}</strong>
        {block.rows.map((row) => (
          <RecurringFormCard
            key={row.add_form_intent}
            block={{
              type: "recurring_form_card",
              question: `Add ${row.merchant} as a recurring expense?`,
              intent_id: row.add_form_intent,
              defaults: row.defaults,
              ...(block.currency ? { currency: block.currency } : {}),
            }}
            resolved={resolved.has(row.add_form_intent)}
            busy={busy}
            onIntent={onIntent}
            onDismiss={onDismiss}
          />
        ))}
      </div>
    );

  const rows: Array<{ label: string; amount?: string; sub?: string; link?: string }> = (() => {
    switch (block.type) {
      case "recap":
        return block.rows.map((row) => ({ label: row.label, amount: row.amount, sub: row.sub }));
      case "transactions_list":
        return block.rows.map((row) => ({
          label: `${row.date_label} · ${row.merchant}`,
          amount: row.amount,
          sub: row.category?.name,
          link: `/activity?transaction=${row.id}`,
        }));
      case "recurring_list":
        return block.rows.map((row) => ({
          label: row.name,
          amount: row.amount,
          sub: `${row.cadence} · ${row.next_occurrence_date}`,
        }));
      case "budget_list":
        return block.rows.map((row) => ({
          label: row.category.name,
          amount: `${row.spent} / ${row.amount}`,
        }));
      case "accounts_list":
        return block.rows.map((row) => ({
          label: row.name,
          amount: row.balance ?? undefined,
          sub: row.institution ?? undefined,
        }));
      case "category_list":
        return block.rows.map((row) => ({ label: row.name }));
      case "goals_list":
        return block.rows.map((row) => ({
          label: row.title,
          amount: `${row.saved} / ${row.target}`,
          sub: row.due_label,
        }));
      case "transaction_detail":
        return [
          {
            label: block.merchant,
            amount: block.amount,
            sub: `${block.date_label}${block.category ? ` · ${block.category.name}` : ""}`,
          },
        ];
      case "goal_detail":
        return [
          { label: block.title, amount: `${block.saved} / ${block.target}`, sub: block.due_label },
          ...(block.allocations ?? []).map((row) => ({
            label: row.category.name,
            amount: `${row.monthly}/mo`,
            sub: row.rationale,
          })),
        ];
      default:
        return [];
    }
  })();
  return (
    <div className={styles.chatCard}>
      <strong>{cardTitle(block)}</strong>
      {block.type === "recap" && block.headline && (
        <div className={styles.chatHeadline}>
          {block.headline.label && <span>{block.headline.label} </span>}
          {formatMoney(Number(block.headline.amount), block.headline.currency ?? "CAD")}
        </div>
      )}
      {block.type === "budget_list" && block.headline && (
        <div className={styles.chatHeadline}>
          {formatMoney(Number(block.headline.spent), block.currency ?? "CAD")} /{" "}
          {formatMoney(Number(block.headline.cap), block.currency ?? "CAD")}
        </div>
      )}
      <div className={styles.chatRows}>
        {rows.length ? (
          rows.map((row, index) => (
            <div key={index}>
              <span>
                {row.link ? <a href={row.link}>{row.label}</a> : row.label}
                {row.sub && <small>{row.sub}</small>}
              </span>
              {row.amount && <strong>{row.amount}</strong>}
            </div>
          ))
        ) : (
          <span className={styles.muted}>No items</span>
        )}
      </div>
      {"footer" in block && block.footer && <span className={styles.muted}>{block.footer}</span>}
      {block.type === "transaction_detail" && (
        <a href={`/activity?transaction=${encodeURIComponent(block.id)}`}>Open transaction</a>
      )}
      {(block.type === "goal_detail" || block.type === "goals_list") && (
        <a href="/goals">Open goals</a>
      )}
      {block.type === "budget_list" && <a href="/budget">Open budget</a>}
      {block.type === "accounts_list" && <a href="/accounts">Open accounts</a>}
    </div>
  );
}

function GoalFormCard({
  block,
  resolved,
  busy,
  onIntent,
  onDismiss,
}: {
  block: GoalForm;
  resolved: boolean;
  busy: boolean;
  onIntent: (id: string, overrides?: Record<string, unknown>) => Promise<void>;
  onDismiss: (id: string) => void;
}) {
  const [title, setTitle] = useState(block.defaults.title ?? "");
  const [amount, setAmount] = useState(block.defaults.target_amount ?? "");
  const [date, setDate] = useState(
    block.defaults.due_date ?? minDueDateOneMonthUTC().toISOString().slice(0, 10),
  );
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isDueDateAtLeastOneMonth(date) || Number(amount) <= 0) return;
    void onIntent(block.intent_id, {
      title: title.trim(),
      target_amount: Number(amount),
      due_date: date,
    });
  }
  return (
    <form className={styles.chatCard} onSubmit={submit}>
      <strong>{block.question}</strong>
      {resolved ? (
        <span className={styles.muted}>Completed or expired</span>
      ) : (
        <>
          <div className={styles.chatForm}>
            <label>
              Goal
              <input
                className={styles.input}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                maxLength={80}
              />
            </label>
            <label>
              Target amount
              <input
                className={styles.input}
                type="number"
                min="0.01"
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                required
              />
            </label>
            <label>
              Target date
              <input
                className={styles.input}
                type="date"
                min={minDueDateOneMonthUTC().toISOString().slice(0, 10)}
                value={date}
                onChange={(event) => setDate(event.target.value)}
                required
              />
            </label>
          </div>
          <div className={styles.actions}>
            <button
              className={styles.button}
              type="submit"
              disabled={busy || !isDueDateAtLeastOneMonth(date)}
            >
              {block.mode === "update" ? "Update goal" : "Add goal"}
            </button>
            <button
              className={styles.buttonSecondary}
              type="button"
              onClick={() => onDismiss(block.intent_id)}
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </form>
  );
}

function RecurringFormCard({
  block,
  resolved,
  busy,
  onIntent,
  onDismiss,
}: {
  block: RecurringForm;
  resolved: boolean;
  busy: boolean;
  onIntent: (id: string, overrides?: Record<string, unknown>) => Promise<void>;
  onDismiss: (id: string) => void;
}) {
  const [name, setName] = useState(block.defaults.name);
  const [amount, setAmount] = useState(block.defaults.amount ?? "");
  const [cadence, setCadence] = useState(block.defaults.cadence ?? "monthly");
  const [date, setDate] = useState(block.defaults.next_occurrence_date ?? "");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (Number(amount) <= 0) return;
    void onIntent(block.intent_id, {
      name: name.trim(),
      amount: Number(amount),
      cadence,
      next_occurrence_date: date,
    });
  }
  return (
    <form className={styles.chatCard} onSubmit={submit}>
      <strong>{block.question}</strong>
      {resolved ? (
        <span className={styles.muted}>Completed or expired</span>
      ) : (
        <>
          <div className={styles.chatForm}>
            <label>
              Name
              <input
                className={styles.input}
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
            <label>
              Amount
              <input
                className={styles.input}
                type="number"
                min="0.01"
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                required
              />
            </label>
            <label>
              Frequency
              <select
                className={styles.input}
                value={cadence}
                onChange={(event) => setCadence(event.target.value as typeof cadence)}
              >
                <option value="monthly">Monthly</option>
                <option value="semimonthly">Twice monthly</option>
                <option value="biweekly">Every two weeks</option>
                <option value="weekly">Weekly</option>
                <option value="yearly">Yearly</option>
              </select>
            </label>
            <label>
              Next date
              <input
                className={styles.input}
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                required
              />
            </label>
          </div>
          <div className={styles.actions}>
            <button className={styles.button} type="submit" disabled={busy}>
              {block.mode === "update" ? "Update recurring" : "Add recurring"}
            </button>
            <button
              className={styles.buttonSecondary}
              type="button"
              onClick={() => onDismiss(block.intent_id)}
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </form>
  );
}

export function FinaChat({
  open,
  workspaceId,
  onClose,
}: {
  open: boolean;
  workspaceId: string | null;
  onClose: () => void;
}) {
  const [thread, setThread] = useState<ChatThreadDTO | null>(null);
  const [messages, setMessages] = useState<ChatMessageDTO[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [busyIntent, setBusyIntent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const olderScrollHeightRef = useRef<number | null>(null);
  const loadVersionRef = useRef(0);

  const loadThread = useCallback(async (id: string, cursor?: string) => {
    const version = ++loadVersionRef.current;
    const query = new URLSearchParams({ limit: "50" });
    if (cursor) query.set("cursor", cursor);
    olderScrollHeightRef.current = cursor ? (messagesRef.current?.scrollHeight ?? null) : null;
    let result: ThreadResponse;
    try {
      result = await apiFetch<ThreadResponse>(`/chat/threads/${id}?${query}`);
    } catch (cause) {
      if (version !== loadVersionRef.current) return;
      throw cause;
    }
    if (version !== loadVersionRef.current) return;
    setThread(result.thread);
    setMessages((previous) => (cursor ? [...result.messages, ...previous] : result.messages));
    setNextCursor(result.nextCursor);
    setResolved((previous) => new Set([...previous, ...result.resolvedIntentIds]));
    if (!cursor) void apiFetch(`/chat/threads/${id}/read`, { method: "POST" }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!open || !workspaceId) return;
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const canonical = await apiFetch<{ thread: ChatThreadDTO }>("/chat/threads", {
          method: "POST",
          body: JSON.stringify({}),
        });
        if (!active) return;
        await loadThread(canonical.thread.id);
      } catch (cause) {
        if (active) setError((cause as { code?: string }).code ?? "Could not load Fina chat.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      loadVersionRef.current += 1;
      olderScrollHeightRef.current = null;
    };
  }, [open, workspaceId, loadThread]);

  useEffect(() => {
    if (open) draftRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const container = messagesRef.current;
    if (!open || !container) return;
    if (olderScrollHeightRef.current !== null) {
      container.scrollTop += container.scrollHeight - olderScrollHeightRef.current;
      olderScrollHeightRef.current = null;
    } else {
      container.scrollTop = container.scrollHeight;
    }
  }, [open, messages, sending]);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!thread || loading || sending) return;
    const parsed = ChatMessageBody.safeParse({ text: draft.trim() });
    if (!parsed.success) {
      setError("Enter a message of up to 4,000 characters.");
      return;
    }
    setSending(true);
    setError(null);
    setDraft("");
    try {
      const result = await apiFetch<{
        userMessage: ChatMessageDTO;
        assistantMessage: ChatMessageDTO;
      }>(`/chat/threads/${thread.id}/messages`, {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      setMessages((previous) => [...previous, result.userMessage, result.assistantMessage]);
    } catch (cause) {
      setDraft(parsed.data.text);
      setError((cause as { code?: string }).code ?? "Could not send message.");
    } finally {
      setSending(false);
    }
  }

  async function consume(id: string, overrides?: Record<string, unknown>) {
    if (!thread?.workspaceId || busyIntent) return;
    setBusyIntent(true);
    setError(null);
    try {
      await apiFetch(`/workspaces/${thread.workspaceId}/intents/${id}/consume`, {
        method: "POST",
        body: JSON.stringify({ ...(overrides ? { overrides } : {}), threadId: thread.id }),
      });
      setResolved((previous) => new Set([...previous, id]));
      await loadThread(thread.id);
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not complete this action.");
    } finally {
      setBusyIntent(false);
    }
  }

  return (
    <>
      <header className={styles.chatPopoverHeader}>
        <div>
          <h2 id="fina-chat-title">Ask Fina</h2>
          <p>Your money assistant</p>
        </div>
        <button
          className={styles.chatClose}
          type="button"
          onClick={onClose}
          aria-label="Close Fina chat"
        >
          ×
        </button>
      </header>
      {error && (
        <div className={styles.error} role="alert">
          {error === "upgrade_required" ? (
            <>
              Fina chat is available with Pro or Max. <a href="/settings/plan">See plans</a>.
            </>
          ) : (
            error
          )}
        </div>
      )}
      <section className={styles.chatConversation} aria-busy={loading || sending}>
        <div className={styles.chatMessages} ref={messagesRef} role="log" aria-label="Fina conversation" aria-live="polite">
          {nextCursor && (
            <button
              className={styles.buttonSecondary}
              type="button"
              disabled={loading}
              onClick={() => {
                if (!thread || loading) return;
                void loadThread(thread.id, nextCursor).catch(() => {
                  olderScrollHeightRef.current = null;
                  setError("Could not load older messages.");
                });
              }}
            >
              Load older messages
            </button>
          )}
          {(loading || !workspaceId) && <div className={styles.empty}>Loading conversation…</div>}
          {!loading && workspaceId && messages.length === 0 && (
            <div className={styles.empty}>Ask Fina a question to start.</div>
          )}
          {messages.map((message) => (
            <div
              className={`${styles.chatMessage} ${message.role === "user" ? styles.chatUser : ""}`}
              key={message.id}
            >
              <span className={styles.chatRole}>{message.role === "user" ? "You" : "Fina"}</span>
              {blocksOf(message).map((block, index) => (
                <ChatBlock
                  key={index}
                  block={block}
                  resolved={resolved}
                  busy={busyIntent}
                  onIntent={consume}
                  onDismiss={(id) => setResolved((previous) => new Set([...previous, id]))}
                />
              ))}
            </div>
          ))}
          {sending && (
            <div className={styles.chatMessage}>
              <span className={styles.chatRole}>Fina</span>
              <p className={styles.chatText}>Thinking…</p>
            </div>
          )}
        </div>
        <form className={styles.chatComposer} onSubmit={send}>
          <label className={styles.field} htmlFor="chat-draft">
            Message Fina
          </label>
          <textarea
            className={styles.input}
            id="chat-draft"
            ref={draftRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            rows={2}
            maxLength={4000}
            disabled={!thread || loading || sending}
            placeholder="How much did I spend this month?"
          />
          <button
            className={styles.button}
            type="submit"
            disabled={!thread || loading || sending || !draft.trim()}
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </form>
      </section>
    </>
  );
}
