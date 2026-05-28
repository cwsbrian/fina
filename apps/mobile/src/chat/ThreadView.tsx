import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  FlatList,
  Platform,
  ActivityIndicator,
  Alert,
  Animated,
  KeyboardAvoidingView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type {
  ChatMessageDTO,
  ChatThreadDTO,
  PresentationBlock as Block,
} from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../api/client";
import { getActiveWorkspaceId } from "../workspace/active";
import { PresentationBlock } from "./PresentationBlock";
import {
  WorkspacePickerSheet,
  type WorkspaceOption,
} from "./WorkspacePickerSheet";
import { colors, space, type as type$ } from "../design/tokens";

type Props = {
  /** `null` means "fresh / pending thread" — no DB row exists yet. The
   *  thread is created lazily on the user's first send. Pass an actual
   *  id (from /chats history) to view an existing conversation. */
  threadId: string | null;
  /** Pixels at the bottom of the parent screen that the keyboard
   *  already covers — typically the tab bar's height when embedded
   *  in the Chat tab. The composer raises by
   *  `keyboardHeight - bottomInset` so it sits flush against the
   *  keyboard. Default 0 (drill-in: nothing below the view). */
  bottomInset?: number;
  /** Fires when a previously-pending thread is promoted to a real
   *  DB row by the first send. The parent (Chat tab) keeps a copy of
   *  the new id so subsequent renders pass it back down. */
  onThreadCreated?: (newId: string) => void;
  /** Forwarded to the messages FlatList — used for collapsing header. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onScroll?: (e: any) => void;
  scrollEventThrottle?: number;
  /** Top padding added to the messages list — usually the header height
   *  when the parent renders an absolute-positioned collapsing header. */
  listTopInset?: number;
  /** Fires whenever the active workspace context for this thread
   *  changes — either because a freshly-loaded thread had its
   *  workspaceId, the user picked a different workspace in the inline
   *  chip, or the first send just bound the thread. Parent uses this
   *  to surface the workspace name in the screen header. `null` name
   *  means single-workspace user or unresolved. */
  onWorkspaceContextChange?: (info: {
    workspaceName: string | null;
    multipleWorkspaces: boolean;
  }) => void;
  /** Fires whenever the loaded thread changes — so the parent can put
   *  the title in the screen header and surface rename/delete actions
   *  on it. `null` means the view is on the fresh / pending state with
   *  nothing to act on. */
  onThreadChange?: (
    thread: { id: string; title: string | null } | null,
  ) => void;
};

type GetThreadResp = { thread: ChatThreadDTO; messages: ChatMessageDTO[] };
type PostMessageResp = {
  threadId: string;
  userMessage: ChatMessageDTO;
  assistantMessage: ChatMessageDTO;
};

export function ThreadView({
  threadId,
  bottomInset = 0,
  onThreadCreated,
  onScroll,
  scrollEventThrottle,
  listTopInset = 0,
  onWorkspaceContextChange,
  onThreadChange,
}: Props) {
  // Local thread id mirrors the prop for switching, but on first send
  // we promote a null prop to a real id WITHOUT waiting for the parent
  // to re-render with the new value (avoids a reload flash).
  const [localId, setLocalId] = useState<string | null>(threadId);
  const [thread, setThread] = useState<ChatThreadDTO | null>(null);
  const [messages, setMessages] = useState<ChatMessageDTO[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList>(null);
  // Workspace-binding chip state. Only relevant before the thread is
  // bound (thread === null OR thread.workspaceId === null). Once bound
  // the chip disappears; subsequent messages must hit the bound ws and
  // there's nothing to pick.
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [pickedWorkspaceId, setPickedWorkspaceId] = useState<string | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);
  // Skips the load useEffect's GET /chat/threads/:id when we just created
  // the thread locally during a send. Without this guard the GET races
  // the in-flight POST /messages: it returns empty messages (the POST
  // hasn't completed) and wipes the optimistic user bubble before the
  // server reply lands.
  const justCreatedId = useRef<string | null>(null);
  // True while any rendered form card is in-edit (not yet submitted /
  // cancelled). We hide the chat composer in this state so the user
  // can focus on the form fields without the composer riding the
  // keyboard up over them.
  const [formFocused, setFormFocused] = useState(false);

  // Sync when the parent switches us to a different thread (e.g. tapping
  // a row in /chats). Reset all local state so the new thread loads cleanly.
  useEffect(() => {
    if (threadId !== localId) {
      setLocalId(threadId);
      setThread(null);
      setMessages([]);
      setErr(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  // Workspace list + initial pick. The chip is visible only when 2+
  // workspaces exist AND the thread isn't bound yet. Default pick
  // mirrors the global active workspace so silent send works in the
  // single-workspace case (chip hidden).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, activeId] = await Promise.all([
          apiFetch<{ workspaces: WorkspaceOption[] }>("/workspaces"),
          getActiveWorkspaceId(),
        ]);
        if (cancelled) return;
        setWorkspaces(list.workspaces);
        setPickedWorkspaceId(activeId ?? list.workspaces[0]?.id ?? null);
      } catch {
        // Non-fatal — onSend's bootstrapActiveWorkspace fallback covers
        // the missing-active case.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Notify parent about the workspace name to surface in the header.
  // Resolves the active id (bound thread.workspaceId, else the user's
  // current pick) against the workspace list and re-fires whenever any
  // of those move. multipleWorkspaces lets the parent decide whether
  // to render a tag at all — single-workspace users don't need it.
  useEffect(() => {
    if (!onWorkspaceContextChange) return;
    const activeId = thread?.workspaceId ?? pickedWorkspaceId;
    const name = activeId
      ? workspaces.find((w) => w.id === activeId)?.name ?? null
      : null;
    onWorkspaceContextChange({
      workspaceName: name,
      multipleWorkspaces: workspaces.length > 1,
    });
  }, [
    onWorkspaceContextChange,
    workspaces,
    pickedWorkspaceId,
    thread?.workspaceId,
  ]);

  // Surface thread identity (id + title) to the parent so it can render
  // the title in its header and offer rename/delete actions on the
  // header tap. Fires `null` on the fresh / pending state.
  useEffect(() => {
    if (!onThreadChange) return;
    if (thread) {
      onThreadChange({ id: thread.id, title: thread.title });
    } else {
      onThreadChange(null);
    }
  }, [onThreadChange, thread]);

  // KeyboardAvoidingView (below) handles all the keyboard offset math —
  // including the iOS app-resume edge case where keyboardWillShow doesn't
  // re-fire on restored keyboard. The `bottomInset` (tab bar height in
  // embedded mode) is passed as keyboardVerticalOffset so the composer
  // lands flush against the keyboard, not under the tab bar.

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, []);

  useEffect(() => {
    // Pending thread: nothing to load. Composer is shown over an empty
    // message list — the user's first send creates the DB row.
    if (!localId) return;
    // First-send race guard: if this localId came from a fresh local
    // create, the in-flight POST /messages has the canonical data —
    // GET /threads/:id would return stale empty messages and wipe the
    // optimistic user bubble.
    if (justCreatedId.current === localId) {
      justCreatedId.current = null;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch<GetThreadResp>(`/chat/threads/${localId}`);
        if (cancelled) return;
        setThread(data.thread);
        setMessages(data.messages);
        scrollToBottom();
        // Mark as read on view — the user is looking at the messages
        // right now, so any unreadCount must drop to 0 immediately and
        // the next Home / chats poll must not show a stale badge.
        markRead(localId);
      } catch (e) {
        if (!cancelled) setErr((e as { code?: string }).code ?? "load_error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [localId, scrollToBottom]);

  const onSend = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setDraft("");
    const tempId = `tmp-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: tempId,
        role: "user",
        blocks: [{ type: "text", markdown: body }] as unknown,
        createdAt: new Date().toISOString(),
      },
    ]);
    scrollToBottom();

    try {
      // Use the user's pre-send pick when set (multi-workspace path);
      // otherwise fall back to active-then-bootstrap so existing
      // single-workspace behavior is preserved.
      const wsId =
        pickedWorkspaceId ??
        (await getActiveWorkspaceId()) ??
        (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");

      // Lazy-create the DB thread on the very first send so empty
      // chats never get persisted. Once it exists, reuse for the rest
      // of the conversation.
      let id = localId;
      if (!id) {
        const created = await apiFetch<{ thread: ChatThreadDTO }>(
          "/chat/threads",
          { method: "POST", body: JSON.stringify({}) },
        );
        id = created.thread.id;
        // Mark BEFORE setLocalId so the load-useEffect skips the GET
        // on the re-render triggered by setLocalId.
        justCreatedId.current = id;
        setLocalId(id);
        setThread(created.thread);
        onThreadCreated?.(id);
      }

      const resp = await apiFetch<PostMessageResp>(
        `/chat/threads/${id}/messages`,
        {
          method: "POST",
          body: JSON.stringify({ text: body, workspaceId: wsId }),
        },
      );
      // Server returns the canonical user+assistant pair. Swap our
      // optimistic temp row for the server's record (so the id lines
      // up for any future updates), then append the assistant reply.
      setMessages((prev) => {
        const withoutTemp = prev.filter((m) => m.id !== tempId);
        return [...withoutTemp, resp.userMessage, resp.assistantMessage];
      });
      // First-send binding: server lazy-binds the thread to wsId on
      // this POST, but its response only carries the new messages, not
      // the updated thread. Mirror the binding into local state so the
      // "Sending to" chip disappears immediately — without this the
      // chip lingered until a full thread reload.
      setThread((prev) =>
        prev && prev.workspaceId === null ? { ...prev, workspaceId: wsId } : prev,
      );
      scrollToBottom();
      // The user is staring at the reply they just received — mark the
      // thread read so it doesn't show as unread on Home / chats list
      // when they navigate away.
      markRead(id);
    } catch (e) {
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setDraft(body);
      const code = (e as { code?: string }).code;
      if (code === "llm_weekly_budget_exceeded") {
        // Friendly KR/EN message — server doesn't localize; we choose
        // based on whether the user's draft looks Korean-leaning.
        const ko = /[ㄱ-힝]/.test(body);
        Alert.alert(
          ko ? "이번 주 AI 사용 한도 도달" : "Weekly AI limit reached",
          ko
            ? "이번 주 AI 한도($5/월)를 모두 사용했어요. 며칠 후 다시 시도해주세요. Fina의 다른 알림은 계속 받아볼 수 있어요."
            : "You've used this week's AI allowance ($5/mo). Try again in a few days — Fina will still send you scheduled briefs.",
        );
        return;
      }
      Alert.alert(
        "Couldn't send",
        code ?? "Try again in a moment.",
      );
    } finally {
      setSending(false);
    }
  };

  if (err) {
    return (
      <View style={styles.center}>
        <Text style={styles.errTitle}>Couldn't load chat</Text>
        <Text style={styles.errBody}>{err}</Text>
      </View>
    );
  }

  // Pending (no DB row yet) renders the empty/composer state directly.
  // For real threads, wait until the GET resolves before rendering so
  // older messages don't flash a blank list first.
  if (localId && !thread) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={[styles.listContent, { paddingTop: space.lg + listTopInset }]}
        onContentSizeChange={scrollToBottom}
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        ListEmptyComponent={
          <View style={styles.startCard}>
            <Text style={styles.startCardTitle}>Say hi</Text>
            <Text style={styles.startCardBody}>
              Tell Fina what's on your mind. "How am I doing this month?" is a
              fine start.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <MessageBubble
            message={item}
            workspaceId={thread?.workspaceId ?? null}
            threadId={localId}
            onFormFocusChange={setFormFocused}
            onConfirmationMessage={(msg) => {
              setMessages((prev) =>
                prev.some((m) => m.id === msg.id) ? prev : [...prev, msg],
              );
              scrollToBottom();
            }}
          />
        )}
        ListFooterComponent={sending ? <TypingIndicator /> : null}
      />

      {/* Workspace picker chip — only visible when:
            (1) thread not yet bound (thread?.workspaceId === null OR no thread),
            (2) user has 2+ workspaces (single-workspace users get the silent
                active-workspace path), and
            (3) at least one workspace has loaded.
          After binding the chip disappears since the choice is locked. */}
      {(thread?.workspaceId ?? null) === null &&
        workspaces.length > 1 &&
        !formFocused && (
          <Pressable
            style={({ pressed }) => [
              styles.wsChip,
              pressed && { backgroundColor: colors.surfaceSoft },
            ]}
            onPress={() => setPickerVisible(true)}
          >
            <Text style={styles.wsChipPrefix}>Sending to </Text>
            <Text style={styles.wsChipName}>
              {workspaces.find((w) => w.id === pickedWorkspaceId)?.name ??
                "Personal"}
            </Text>
            <Ionicons
              name="chevron-down"
              size={14}
              color={colors.muted}
              style={{ marginLeft: 4 }}
            />
          </Pressable>
        )}

      {/* Composer is hidden while a form card is in-edit — the user
          isn't chatting, they're filling out a form. The KeyboardAvoidingView
          still lifts the form into view; without the composer the form's
          own inputs sit naturally above the keyboard. */}
      {!formFocused && (
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          placeholder="Message Fina…"
          placeholderTextColor={colors.muted}
          value={draft}
          onChangeText={setDraft}
          multiline
          editable={!sending}
          returnKeyType="default"
        />
        <Pressable
          style={({ pressed }) => [
            styles.sendBtn,
            (draft.trim().length === 0 || sending) && styles.sendBtnDisabled,
            pressed && draft.trim().length > 0 && { opacity: 0.85 },
          ]}
          onPress={onSend}
          disabled={draft.trim().length === 0 || sending}
        >
          {sending ? (
            <ActivityIndicator size="small" color={colors.onPrimary} />
          ) : (
            <Ionicons name="arrow-up" size={20} color={colors.onPrimary} />
          )}
        </Pressable>
      </View>
      )}
      <WorkspacePickerSheet
        visible={pickerVisible}
        workspaces={workspaces}
        selectedId={pickedWorkspaceId}
        onSelect={(id) => setPickedWorkspaceId(id)}
        onClose={() => setPickerVisible(false)}
      />
    </KeyboardAvoidingView>
  );
}


/** Three-dot bouncing indicator inside an assistant-style bubble. Shown
 *  while a chat turn is in flight so the user knows Fina is "thinking",
 *  rather than guessing whether the tap registered. */
function TypingIndicator() {
  const dots = useRef([new Animated.Value(0), new Animated.Value(0), new Animated.Value(0)]).current;
  useEffect(() => {
    const animations = dots.map((d, i) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(i * 150),
          Animated.timing(d, { toValue: 1, duration: 350, useNativeDriver: true }),
          Animated.timing(d, { toValue: 0, duration: 350, useNativeDriver: true }),
          Animated.delay(450 - i * 150),
        ]),
      );
    });
    for (const a of animations) a.start();
    return () => {
      for (const a of animations) a.stop();
    };
  }, [dots]);
  return (
    <View style={[styles.row, styles.rowAssistant]}>
      <View style={[styles.bubble, styles.bubbleAssistant, styles.typingBubble]}>
        {dots.map((d, i) => (
          <Animated.View
            key={i}
            style={[
              styles.typingDot,
              {
                opacity: d.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }),
                transform: [
                  {
                    translateY: d.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, -3],
                    }),
                  },
                ],
              },
            ]}
          />
        ))}
      </View>
    </View>
  );
}

/** Block kinds rendered as self-contained cards instead of inside a chat
 *  bubble. Adding a new card-style block here lifts it out of the bubble
 *  and lets it use its own surface treatment (border, padding, etc). */
function isCardBlock(b: Block): boolean {
  return (
    b.type === "recap" ||
    b.type === "transactions_list" ||
    b.type === "recurring_list" ||
    b.type === "recurring_form_card" ||
    b.type === "confirm_card" ||
    b.type === "categorize_confirm_card"
  );
}

/** Best-effort POST /chat/threads/:id/read. We never block the UI on
 *  this; a failed call just means the unread count drops on the next
 *  poll. Silently swallow so chat keeps flowing even when /read is
 *  slow or unreachable. */
function markRead(threadId: string): void {
  apiFetch(`/chat/threads/${threadId}/read`, { method: "POST" }).catch(() => {});
}

/** Workspace-scoped helper that POSTs to /workspaces/:wsId/intents/:id/consume
 *  with the form's edited values + the active threadId so the server
 *  can post an assistant confirmation message into the same conversation.
 *  Returns the confirmation message when the server emitted one; caller
 *  appends it to the local message list. */
async function submitFormIntent(
  workspaceId: string | null,
  threadId: string | null,
  intentId: string,
  overrides: Record<string, unknown>,
): Promise<ChatMessageDTO | null> {
  if (!workspaceId) throw new Error("no_workspace");
  const body: Record<string, unknown> = { overrides };
  if (threadId) body.threadId = threadId;
  const resp = await apiFetch<{ result: unknown; confirmationMessage?: ChatMessageDTO }>(
    `/workspaces/${workspaceId}/intents/${intentId}/consume`,
    { method: "POST", body: JSON.stringify(body) },
  );
  return resp.confirmationMessage ?? null;
}

function MessageBubble({
  message,
  workspaceId,
  threadId,
  onFormFocusChange,
  onConfirmationMessage,
}: {
  message: ChatMessageDTO;
  workspaceId: string | null;
  threadId: string | null;
  onFormFocusChange?: (focused: boolean) => void;
  onConfirmationMessage?: (msg: ChatMessageDTO) => void;
}) {
  const blocks = Array.isArray(message.blocks)
    ? (message.blocks as Block[])
    : [];
  const isUser = message.role === "user";

  // Render each block as its own visual row. Text blocks get the standard
  // chat bubble; card blocks render full-width (within the list padding)
  // so the structured surface treatment from BlockCard / confirm card
  // can carry without an outer rounded bubble fighting it.
  return (
    <View style={{ gap: 6 }}>
      {blocks.map((b, i) => {
        const key = `${message.id}-${i}`;
        if (isCardBlock(b)) {
          return (
            <View key={key} style={styles.cardRow}>
              <PresentationBlock
                block={b}
                role={message.role}
                onAccept={async (intentId) => {
                  // confirm_card accept = consume the bound intent with
                  // no overrides (the LLM-supplied args are already
                  // complete). Reuse submitFormIntent — the server
                  // treats {} the same as undefined overrides.
                  try {
                    const confirmation = await submitFormIntent(
                      workspaceId,
                      threadId,
                      intentId,
                      {},
                    );
                    if (confirmation && onConfirmationMessage) {
                      onConfirmationMessage(confirmation);
                    }
                  } catch {
                    // Surface via the card's own UI in a future pass;
                    // for now swallow so a transient network error
                    // doesn't crash the message list.
                  }
                }}
                onReject={() => {
                  // No server call — the intent expires via its TTL.
                  // Future polish: dim the card so the user sees the
                  // choice was registered.
                }}
                onSubmitForm={async (id, overrides) => {
                  const confirmation = await submitFormIntent(
                    workspaceId,
                    threadId,
                    id,
                    overrides,
                  );
                  if (confirmation && onConfirmationMessage) {
                    onConfirmationMessage(confirmation);
                  }
                }}
                {...(onFormFocusChange ? { onFormFocusChange } : {})}
              />
            </View>
          );
        }
        return (
          <View
            key={key}
            style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}
          >
            <View
              style={[
                styles.bubble,
                isUser ? styles.bubbleUser : styles.bubbleAssistant,
              ]}
            >
              <PresentationBlock block={b} role={message.role} />
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.lg },
  errTitle: { ...type$.titleMd, color: colors.down, marginBottom: 4 },
  errBody: { ...type$.bodyMd, color: colors.body, textAlign: "center" },
  listContent: { padding: space.lg, gap: space.sm },
  row: { flexDirection: "row", marginVertical: 4 },
  rowUser: { justifyContent: "flex-end" },
  rowAssistant: { justifyContent: "flex-start" },
  bubble: {
    maxWidth: "82%",
    paddingHorizontal: space.base,
    paddingVertical: 10,
    borderRadius: 18,
  },
  bubbleUser: { backgroundColor: colors.primary, borderBottomRightRadius: 4 },
  bubbleAssistant: { backgroundColor: colors.surfaceSoft, borderBottomLeftRadius: 4 },
  cardRow: {
    // Card blocks render full-width within the list's padding rather than
    // inside an alignment-flex row, so they don't get squeezed to 82%.
    marginVertical: 4,
  },
  typingBubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 12,
  },
  typingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.muted,
  },
  startCard: {
    backgroundColor: colors.surfaceSoft,
    padding: space.base,
    borderRadius: 14,
  },
  startCardTitle: { ...type$.titleSm, color: colors.ink, marginBottom: 4 },
  startCardBody: { ...type$.bodyMd, color: colors.body },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space.xs,
    padding: space.sm + 2,
    borderTopWidth: 1,
    borderTopColor: colors.hairlineSoft,
    backgroundColor: colors.canvas,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    paddingHorizontal: space.sm + 2,
    paddingVertical: 10,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 22,
    fontSize: 16,
    color: colors.ink,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 999,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDisabled: { backgroundColor: colors.primaryDisabled },
  wsChip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "center",
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    marginBottom: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.canvas,
  },
  wsChipPrefix: { ...type$.caption, color: colors.muted },
  wsChipName: { ...type$.caption, color: colors.ink, fontWeight: "600" },
});
