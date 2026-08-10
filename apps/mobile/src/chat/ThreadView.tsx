import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Keyboard,
  Modal,
  type LayoutChangeEvent,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { router } from "expo-router";
import {
  isApiError,
  type CategoryDTO,
  type ChatMessageDTO,
  type ChatThreadDTO,
  type PresentationBlock as Block,
} from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../api/client";
import { copyTextToClipboard } from "../iap/native-subscription-store";
import { PresentationBlock } from "./PresentationBlock";
import { CategoryPickerSheet } from "../categories/CategoryPickerSheet";
import type { WorkspaceOption } from "./WorkspacePickerSheet";
import { colors, space, type as type$ } from "../design/tokens";

type Props = {
  /** The canonical thread for the active workspace. A null value is
   *  tolerated while the parent bootstraps that workspace. */
  threadId: string | null;
  /** Fires if this view had to bootstrap a missing canonical thread. */
  onThreadCreated?: (newId: string) => void;
  /** Forwarded to the messages FlatList — used for collapsing header. */
  onScroll?: (e: any) => void;
  scrollEventThrottle?: number;
  /** Top padding added to the messages list — usually the header height
   *  when the parent renders an absolute-positioned collapsing header. */
  listTopInset?: number;
  /** Fires whenever the canonical thread's workspace context resolves. */
  onWorkspaceContextChange?: (info: {
    workspaceName: string | null;
    multipleWorkspaces: boolean;
  }) => void;
  /** Fires whenever the loaded thread changes — so the parent can put
   *  the title in the screen header and surface rename/delete actions
   *  on it. `null` means the view is on the fresh / pending state with
   *  nothing to act on. */
  onThreadChange?: (thread: { id: string; title: string | null } | null) => void;
};

type GetThreadResp = {
  thread: ChatThreadDTO;
  messages: ChatMessageDTO[];
  /** Cursor for the next, older page. Null means the full history is loaded. */
  nextCursor?: string | null;
  /** accept_intent ids whose ActionIntent is already consumed or expired —
   *  their action cards must stay closed across re-entry (the dismissal is
   *  otherwise only in-memory). */
  resolvedIntentIds?: string[];
};
type PostMessageResp = {
  threadId: string;
  userMessage: ChatMessageDTO;
  assistantMessage: ChatMessageDTO;
};
type ActiveDetailBlock = { block: Block; message: ChatMessageDTO };
type DetailFormActions = {
  submit: () => void;
  cancel: () => void;
};
type DetailFormState = {
  canSubmit: boolean;
  submitting: boolean;
  done: boolean;
  cancelled: boolean;
};
type DetailActionKind = "none" | "form" | "intent";

const CHAT_SUPPORT_SUBJECT = "Chat issue";
const CHAT_SUPPORT_ANSWER_LIMIT = 1800;
const DETAIL_BLOB_MIN_WIDTH = 196;
const SUPPORT_ACTION_ICON_SIZE = 16;
const SUPPORT_ACTION_MIN_WIDTH = SUPPORT_ACTION_ICON_SIZE * 2 + space.sm;
const MESSAGE_PAGE_SIZE = 30;

function chatSupportAnswerText(message: ChatMessageDTO): string {
  const blocks = Array.isArray(message.blocks) ? (message.blocks as Block[]) : [];
  const text = blocks
    .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
    .map((b) => b.markdown)
    .join("\n\n")
    .trim();
  if (text.length === 0) {
    const blockTypes = blocks.map((b) => b.type).join(", ");
    return blockTypes ? `(structured answer: ${blockTypes})` : "(empty answer)";
  }
  if (text.length <= CHAT_SUPPORT_ANSWER_LIMIT) return text;
  return `${text.slice(0, CHAT_SUPPORT_ANSWER_LIMIT).trimEnd()}\n...`;
}

function assistantCopyText(message: ChatMessageDTO): string {
  const blocks = Array.isArray(message.blocks) ? (message.blocks as Block[]) : [];
  return blocks
    .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
    .map((b) => b.markdown.trim())
    .filter(Boolean)
    .join("\n\n");
}

function buildChatSupportMessage({
  note,
  threadId,
  message,
}: {
  note: string;
  threadId: string | null;
  message: ChatMessageDTO;
}): string {
  return [
    note.trim(),
    "",
    "---- Chat context ----",
    `Thread ID: ${threadId ?? "pending"}`,
    `Message ID: ${message.id}`,
    "Fina answer:",
    chatSupportAnswerText(message),
  ].join("\n");
}

export function ThreadView({
  threadId,
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
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Bumped on every send to force-remount the composer TextInput. Clearing the
  // controlled value (and even .clear()) leaves a residual marked-text syllable
  // under the iOS Korean (CJK) IME, so the just-sent text reappears in the
  // field. Remounting throws away the native input + its IME composition state.
  const [composerKey, setComposerKey] = useState(0);
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<ChatMessageDTO>>(null);
  const localIdRef = useRef<string | null>(threadId);
  const loadingOlderRef = useRef(false);
  const userRequestedOlderRef = useRef(false);
  const inputRef = useRef<TextInput>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
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
  // Intent ids the user has already resolved via a confirm_card's
  // Yes/No this session. Re-rendering filters those cards out so the
  // user sees the action commit, not a still-clickable button row.
  // Per-session only — a reload re-fetches the server's view of the
  // thread (which includes the assistant's confirmation message and
  // the now-consumed intent, so re-hiding isn't critical).
  const [dismissedIntents, setDismissedIntents] = useState<Set<string>>(() => new Set());
  const [supportMessage, setSupportMessage] = useState<ChatMessageDTO | null>(null);
  const [supportNote, setSupportNote] = useState("");
  const [supportSubmitting, setSupportSubmitting] = useState(false);
  const [supportErr, setSupportErr] = useState<string | null>(null);
  const [activeDetailBlock, setActiveDetailBlock] = useState<ActiveDetailBlock | null>(null);
  const [detailFormState, setDetailFormState] = useState<DetailFormState | null>(null);
  const detailFormActionsRef = useRef<DetailFormActions | null>(null);
  const detailSnapPoints = useMemo(() => ["68%", "92%"], []);
  const detailSheetRef = useRef<BottomSheetModal>(null);
  const categoryPickedRef = useRef<((cat: CategoryDTO | null) => void) | null>(null);
  const [categoryPickerTxId, setCategoryPickerTxId] = useState<string | null>(null);
  const supportCanSubmit =
    supportMessage?.role === "assistant" && supportNote.trim().length > 0 && !supportSubmitting;

  // Sync when the active workspace changes and the parent supplies its
  // canonical thread. Reset local state so the conversation loads cleanly.
  useEffect(() => {
    setLocalId(threadId);
    localIdRef.current = threadId;
    setThread(null);
    setMessages([]);
    setOlderCursor(null);
    setLoadingOlder(false);
    loadingOlderRef.current = false;
    userRequestedOlderRef.current = false;
    setErr(null);
  }, [threadId]);

  // Workspace names are display-only. Message routing always comes from
  // the canonical thread and can no longer be changed in the composer.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await apiFetch<{ workspaces: WorkspaceOption[] }>("/workspaces");
        if (cancelled) return;
        setWorkspaces(list.workspaces);
      } catch {
        // Non-fatal: the thread still carries the authoritative workspace id.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Notify parent about the workspace name to surface in the header.
  // Resolve the bound workspace id against the display-name list.
  useEffect(() => {
    if (!onWorkspaceContextChange) return;
    const activeId = thread?.workspaceId ?? null;
    const name = activeId ? (workspaces.find((w) => w.id === activeId)?.name ?? null) : null;
    onWorkspaceContextChange({
      workspaceName: name,
      multipleWorkspaces: workspaces.length > 1,
    });
  }, [onWorkspaceContextChange, workspaces, thread?.workspaceId]);

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

  // This view already ends above the tab bar. KeyboardAvoidingView therefore
  // needs no extra offset; adding the tab-bar height would double-count that
  // space and leave a large gap above the iOS keyboard.

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
    });
  }, []);

  // State stays chronological for the rest of the chat logic. FlatList gets
  // newest-first data and renders inverted, so offset 0 is the latest message
  // immediately — no top-to-bottom entrance animation or full-history render.
  const invertedMessages = useMemo(() => [...messages].reverse(), [messages]);

  const renderDetailBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={0.35}
        pressBehavior="close"
      />
    ),
    [],
  );

  const dismissIntent = useCallback((intentId: string) => {
    setDismissedIntents((prev) => {
      if (prev.has(intentId)) return prev;
      const next = new Set(prev);
      next.add(intentId);
      return next;
    });
  }, []);

  const appendConfirmationMessage = useCallback(
    (msg: ChatMessageDTO) => {
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      scrollToBottom();
    },
    [scrollToBottom],
  );

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
        const data = await apiFetch<GetThreadResp>(
          `/chat/threads/${localId}?limit=${MESSAGE_PAGE_SIZE}`,
        );
        if (cancelled) return;
        setThread(data.thread);
        setMessages(data.messages);
        setOlderCursor(data.nextCursor ?? null);
        // Seed the dismissal set from server truth so already-resolved cards
        // (consumed/expired intents) don't re-open on re-entry.
        setDismissedIntents(new Set(data.resolvedIntentIds ?? []));
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
  }, [localId]);

  const loadOlderMessages = useCallback(async () => {
    const id = localId;
    const cursor = olderCursor;
    if (!id || !cursor || loadingOlderRef.current) return;

    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const data = await apiFetch<GetThreadResp>(
        `/chat/threads/${id}?limit=${MESSAGE_PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`,
      );
      if (localIdRef.current !== id) return;

      setMessages((current) => {
        const knownIds = new Set(current.map((message) => message.id));
        const older = data.messages.filter((message) => !knownIds.has(message.id));
        return [...older, ...current];
      });
      setOlderCursor(data.nextCursor ?? null);
      setDismissedIntents((current) => {
        const next = new Set(current);
        for (const intentId of data.resolvedIntentIds ?? []) next.add(intentId);
        return next;
      });
    } catch {
      // Keep the cursor so another upward scroll can retry without replacing
      // the already-visible conversation with a full-screen error.
    } finally {
      if (localIdRef.current === id) {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      }
    }
  }, [localId, olderCursor]);

  const handleOlderEndReached = useCallback(() => {
    // Inverted FlatList may call onEndReached during its first layout. Only a
    // real upward drag is allowed to fetch another page.
    if (!userRequestedOlderRef.current) return;
    userRequestedOlderRef.current = false;
    void loadOlderMessages();
  }, [loadOlderMessages]);

  // After a send completes the composer was force-remounted (key bump) to clear
  // the CJK IME residual, which also drops focus. Refocus once it's editable
  // again so the keyboard stays up for the next message. Only after a real send
  // (composerKey > 0) — never steal focus on first open.
  useEffect(() => {
    if (sending || composerKey === 0) return;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [sending, composerKey]);

  const onSend = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setDraft("");
    // Imperative clear too: clearing the controlled value alone leaves a
    // residual composing syllable in the field under the Korean (CJK) IME,
    // so the text reappears after send. .clear() resets native composition.
    inputRef.current?.clear();
    // Remount the composer so the CJK IME composing buffer is fully discarded.
    setComposerKey((k) => k + 1);
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
      // Normally the parent creates this canonical thread before rendering.
      // Keep a bootstrap fallback for older deep links and interrupted loads.
      let id = localId;
      if (!id) {
        const wsId = await bootstrapActiveWorkspace();
        if (!wsId) throw new Error("no_workspace");
        const created = await apiFetch<{ thread: ChatThreadDTO }>("/chat/threads", {
          method: "POST",
          body: JSON.stringify({}),
        });
        id = created.thread.id;
        // Mark BEFORE setLocalId so the load-useEffect skips the GET
        // on the re-render triggered by setLocalId.
        justCreatedId.current = id;
        setLocalId(id);
        localIdRef.current = id;
        setThread(created.thread);
        onThreadCreated?.(id);
      }

      const resp = await apiFetch<PostMessageResp>(`/chat/threads/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({ text: body }),
      });
      // Server returns the canonical user+assistant pair. Swap our
      // optimistic temp row for the server's record (so the id lines
      // up for any future updates), then append the assistant reply.
      setMessages((prev) => {
        const withoutTemp = prev.filter((m) => m.id !== tempId);
        return [...withoutTemp, resp.userMessage, resp.assistantMessage];
      });
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
      Alert.alert("Couldn't send", code ?? "Try again in a moment.");
    } finally {
      setSending(false);
    }
  };

  const openSupport = useCallback((message: ChatMessageDTO) => {
    if (message.role !== "assistant") return;
    Keyboard.dismiss();
    setSupportMessage(message);
    setSupportNote("");
    setSupportErr(null);
  }, []);

  const closeSupport = useCallback(() => {
    if (supportSubmitting) return;
    setSupportMessage(null);
    setSupportNote("");
    setSupportErr(null);
  }, [supportSubmitting]);

  const submitSupport = useCallback(async () => {
    if (!supportCanSubmit || !supportMessage) return;
    setSupportSubmitting(true);
    setSupportErr(null);
    try {
      await apiFetch("/support/tickets", {
        method: "POST",
        body: JSON.stringify({
          subject: CHAT_SUPPORT_SUBJECT,
          message: buildChatSupportMessage({
            note: supportNote,
            threadId: localId,
            message: supportMessage,
          }),
          attachments: [],
        }),
      });
      setSupportMessage(null);
      setSupportNote("");
      Alert.alert("Sent", "We'll reply by email.");
    } catch (e) {
      setSupportErr((e as { code?: string }).code ?? "send_failed");
    } finally {
      setSupportSubmitting(false);
    }
  }, [localId, supportCanSubmit, supportMessage, supportNote]);

  const openDetail = useCallback((block: Block, message: ChatMessageDTO) => {
    Keyboard.dismiss();
    const route = detailRouteForBlock(block);
    if (route) {
      router.push(route as never);
      return;
    }
    detailFormActionsRef.current = null;
    setDetailFormState(null);
    setActiveDetailBlock({ block, message });
    requestAnimationFrame(() => detailSheetRef.current?.present());
  }, []);

  const clearDetailState = useCallback(() => {
    detailFormActionsRef.current = null;
    setDetailFormState(null);
    setActiveDetailBlock(null);
    setFormFocused(false);
  }, []);

  const closeDetail = useCallback(() => {
    detailSheetRef.current?.dismiss();
  }, []);

  const handleOpenActivityFromDetail = useCallback(() => {
    detailSheetRef.current?.dismiss();
    router.push("/(tabs)/activity" as never);
  }, []);

  const handleChangeCategoryFromDetail = useCallback(
    (txId: string, onPicked: (cat: CategoryDTO | null) => void) => {
      categoryPickedRef.current = onPicked;
      setCategoryPickerTxId(txId);
    },
    [],
  );

  const handleCategoryPickerClose = useCallback(() => {
    setCategoryPickerTxId(null);
    categoryPickedRef.current = null;
  }, []);

  const acceptDetailIntent = useCallback(
    async (intentId: string) => {
      dismissIntent(intentId);
      try {
        const confirmation = await submitFormIntent(
          thread?.workspaceId ?? null,
          localId,
          intentId,
          {},
        );
        if (confirmation) appendConfirmationMessage(confirmation);
        closeDetail();
      } catch (e) {
        notifyConsumeError(e);
      }
    },
    [appendConfirmationMessage, closeDetail, dismissIntent, localId, thread?.workspaceId],
  );

  const rejectDetailIntent = useCallback(() => {
    const block = activeDetailBlock?.block;
    if (block?.type === "confirm_card" || block?.type === "plan_proposal_card") {
      dismissIntent(block.accept_intent);
    }
    closeDetail();
  }, [activeDetailBlock?.block, closeDetail, dismissIntent]);

  const submitDetailForm = useCallback(
    async (intentId: string, overrides: Record<string, unknown>) => {
      try {
        const confirmation = await submitFormIntent(
          thread?.workspaceId ?? null,
          localId,
          intentId,
          overrides,
        );
        if (confirmation) appendConfirmationMessage(confirmation);
      } catch (e) {
        notifyConsumeError(e);
        throw e;
      }
    },
    [appendConfirmationMessage, localId, thread?.workspaceId],
  );

  const handleDetailFormActions = useCallback((actions: DetailFormActions | null) => {
    detailFormActionsRef.current = actions;
  }, []);

  const handleDetailFormActionState = useCallback((state: DetailFormState) => {
    setDetailFormState(state);
  }, []);

  const handleDetailCancel = useCallback(() => {
    const block = activeDetailBlock?.block;
    if (block && isIntentDetailBlock(block)) {
      rejectDetailIntent();
      return;
    }
    closeDetail();
  }, [activeDetailBlock?.block, closeDetail, rejectDetailIntent]);

  const handleDetailSave = useCallback(() => {
    const block = activeDetailBlock?.block;
    if (!block) return;
    if (isFormDetailBlock(block)) {
      detailFormActionsRef.current?.submit();
      return;
    }
    if (isIntentDetailBlock(block)) {
      void acceptDetailIntent(block.accept_intent);
    }
  }, [acceptDetailIntent, activeDetailBlock?.block]);

  const activeDetail = activeDetailBlock?.block ?? null;
  const detailActionKind = activeDetail ? detailActionKindForBlock(activeDetail) : "none";
  const detailTitle = activeDetail ? detailTitleForBlock(activeDetail) : "Detail";
  const detailShowSave =
    detailActionKind === "intent" ||
    (detailActionKind === "form" &&
      detailFormState?.done !== true &&
      detailFormState?.cancelled !== true);
  const detailSaveDisabled =
    detailActionKind === "form"
      ? detailFormState?.canSubmit !== true
      : detailActionKind !== "intent";
  const detailSaving = detailActionKind === "form" && detailFormState?.submitting === true;

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
        data={invertedMessages}
        inverted={invertedMessages.length > 0}
        keyExtractor={(m) => m.id}
        contentContainerStyle={[
          styles.listContent,
          invertedMessages.length > 0
            ? { paddingBottom: space.lg + listTopInset }
            : { paddingTop: space.lg + listTopInset },
        ]}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        onScroll={onScroll}
        onScrollBeginDrag={() => {
          userRequestedOlderRef.current = true;
        }}
        onEndReached={handleOlderEndReached}
        onEndReachedThreshold={0.2}
        scrollEventThrottle={scrollEventThrottle}
        ListEmptyComponent={
          <View style={styles.startCard}>
            <Text style={styles.startCardTitle}>Tell Fina what you spent</Text>
            <Text style={styles.startCardBody}>
              Add a purchase in one sentence. No bank connection needed.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Use example transaction"
              style={({ pressed }) => [styles.startSuggestion, pressed && { opacity: 0.7 }]}
              onPress={() => {
                setDraft("Coffee $5 this morning");
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
            >
              <Text style={styles.startSuggestionText}>“Coffee $5 this morning”</Text>
            </Pressable>
          </View>
        }
        renderItem={({ item }) => (
          <MessageBubble
            message={item}
            dismissedIntents={dismissedIntents}
            onDetailPress={openDetail}
            onSupportPress={openSupport}
            onAccept={acceptDetailIntent}
            onSubmitForm={submitDetailForm}
            onFormFocusChange={setFormFocused}
            onOpenActivity={handleOpenActivityFromDetail}
            onChangeCategory={handleChangeCategoryFromDetail}
            onDismissIntent={dismissIntent}
          />
        )}
        ListHeaderComponent={sending ? <TypingIndicator /> : null}
        ListFooterComponent={
          loadingOlder ? (
            <View style={styles.olderLoader}>
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          ) : null
        }
      />

      {/* Composer is hidden while a form card is in-edit — the user
          isn't chatting, they're filling out a form. The KeyboardAvoidingView
          still lifts the form into view; without the composer the form's
          own inputs sit naturally above the keyboard. */}
      {!formFocused && (
        <View style={styles.composer}>
          <TextInput
            key={composerKey}
            ref={inputRef}
            style={styles.input}
            placeholder="Tell Fina what you spent…"
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
      <BottomSheetModal
        ref={detailSheetRef}
        snapPoints={detailSnapPoints}
        enableDynamicSizing={false}
        index={0}
        backdropComponent={renderDetailBackdrop}
        onDismiss={clearDetailState}
        handleIndicatorStyle={styles.grabber}
        backgroundStyle={styles.sheetBackground}
        enablePanDownToClose
      >
        <View style={styles.detailSheetHeader}>
          <View style={styles.detailHeaderSide}>
            <Pressable
              onPress={handleDetailCancel}
              accessibilityRole="button"
              accessibilityLabel="Cancel detail"
              hitSlop={8}
              style={({ pressed }) => [styles.detailHeaderAction, pressed && { opacity: 0.65 }]}
            >
              <Text style={styles.detailHeaderActionText}>Cancel</Text>
            </Pressable>
          </View>
          <Text style={styles.detailSheetTitle} numberOfLines={1}>
            {detailTitle}
          </Text>
          <View style={[styles.detailHeaderSide, styles.detailHeaderRight]}>
            {detailShowSave ? (
              <Pressable
                onPress={handleDetailSave}
                disabled={detailSaveDisabled}
                accessibilityRole="button"
                accessibilityLabel="Save detail"
                hitSlop={8}
                style={({ pressed }) => [
                  styles.detailHeaderAction,
                  detailSaveDisabled && styles.detailHeaderDisabled,
                  pressed && !detailSaveDisabled && { opacity: 0.65 },
                ]}
              >
                {detailSaving ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <Text style={styles.detailHeaderSaveText}>Save</Text>
                )}
              </Pressable>
            ) : null}
          </View>
        </View>
        <BottomSheetScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.detailSheetContent}
        >
          {activeDetailBlock && (
            <PresentationBlock
              block={activeDetailBlock.block}
              role={activeDetailBlock.message.role}
              presentation="sheet"
              formActions="header"
              onAccept={acceptDetailIntent}
              onReject={rejectDetailIntent}
              onSubmitForm={submitDetailForm}
              onFormFocusChange={setFormFocused}
              onFormActionsChange={handleDetailFormActions}
              onFormActionStateChange={handleDetailFormActionState}
              onOpenActivity={handleOpenActivityFromDetail}
              onChangeCategory={handleChangeCategoryFromDetail}
            />
          )}
        </BottomSheetScrollView>
      </BottomSheetModal>
      <Modal
        visible={categoryPickerTxId !== null}
        transparent
        animationType="none"
        onRequestClose={handleCategoryPickerClose}
      >
        <View style={styles.categoryPickerModal}>
          <CategoryPickerSheet
            visible={categoryPickerTxId !== null}
            {...(categoryPickerTxId ? { txId: categoryPickerTxId } : {})}
            onClose={handleCategoryPickerClose}
            onSelect={(cat) => categoryPickedRef.current?.(cat)}
          />
        </View>
      </Modal>
      <Modal
        visible={supportMessage?.role === "assistant"}
        transparent
        animationType="fade"
        onRequestClose={closeSupport}
      >
        <KeyboardAvoidingView
          style={styles.modalAvoid}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <View style={styles.modalBackdrop}>
            <View style={styles.supportModal}>
              <Text style={styles.supportTitle}>Report this answer</Text>
              <TextInput
                value={supportNote}
                onChangeText={setSupportNote}
                placeholder="What went wrong?"
                placeholderTextColor={colors.mutedSoft}
                style={styles.supportInput}
                multiline
                textAlignVertical="top"
                editable={!supportSubmitting}
                maxLength={2400}
                autoFocus
              />
              {supportErr && <Text style={styles.supportErr}>Couldn't send: {supportErr}</Text>}
              <View style={styles.supportActions}>
                <Pressable
                  onPress={closeSupport}
                  disabled={supportSubmitting}
                  style={({ pressed }) => [
                    styles.supportBtn,
                    styles.supportBtnSecondary,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={styles.supportBtnSecondaryText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={submitSupport}
                  disabled={!supportCanSubmit}
                  style={({ pressed }) => [
                    styles.supportBtn,
                    styles.supportBtnPrimary,
                    (!supportCanSubmit || pressed) && { opacity: 0.7 },
                  ]}
                >
                  {supportSubmitting ? (
                    <ActivityIndicator size="small" color={colors.onPrimary} />
                  ) : (
                    <Text style={styles.supportBtnPrimaryText}>Send</Text>
                  )}
                </Pressable>
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </KeyboardAvoidingView>
  );
}

/** Three-dot bouncing indicator inside an assistant-style bubble. Shown
 *  while a chat turn is in flight so the user knows Fina is "thinking",
 *  rather than guessing whether the tap registered. */
function TypingIndicator() {
  const dots = useRef([
    new Animated.Value(0),
    new Animated.Value(0),
    new Animated.Value(0),
  ]).current;
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

type FormDetailBlock = Extract<Block, { type: "recurring_form_card" | "goal_form_card" }>;
type IntentDetailBlock = Extract<Block, { type: "confirm_card" | "plan_proposal_card" }>;

function isFormDetailBlock(block: Block): block is FormDetailBlock {
  return block.type === "recurring_form_card" || block.type === "goal_form_card";
}

function isIntentDetailBlock(block: Block): block is IntentDetailBlock {
  return block.type === "confirm_card" || block.type === "plan_proposal_card";
}

function detailActionKindForBlock(block: Block): DetailActionKind {
  if (isFormDetailBlock(block)) return "form";
  if (isIntentDetailBlock(block)) return "intent";
  return "none";
}

function detailTitleForBlock(block: Block): string {
  switch (block.type) {
    case "recurring_form_card":
      return block.mode === "update" ? "Update Recurring" : "Add Recurring";
    case "goal_form_card":
      return block.mode === "update" ? "Update Goal" : "Add Goal";
    case "confirm_card":
      return "Confirm";
    case "plan_proposal_card":
      return "Review Plan";
    case "categorize_confirm_card":
      return "Review Categories";
    case "recap":
    case "transactions_list":
    case "recurring_list":
    case "budget_list":
    case "accounts_list":
    case "scheduled_list":
    case "recurring_candidates":
    case "category_list":
    case "goals_list":
      return block.title;
    case "transaction_detail":
      return "Transaction Detail";
    case "goal_detail":
      return "Goal Detail";
    case "text":
      return "Detail";
  }
}

function detailLabelForBlock(block: Block): string {
  if (block.type === "categorize_confirm_card") return "Review categories";
  return "View detail";
}

function detailRouteForBlock(block: Block): string | null {
  switch (block.type) {
    case "category_list":
      return "/categories";
    case "accounts_list":
      return "/banks";
    case "recurring_list":
      return "/subscriptions";
    case "goals_list":
      return "/goals";
    case "goal_detail":
      return `/goal/${block.id}`;
    case "transaction_detail":
      return `/transactions/${block.id}`;
    case "budget_list":
      return "/budget";
    default:
      return null;
  }
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
    b.type === "categorize_confirm_card" ||
    b.type === "budget_list" ||
    b.type === "accounts_list" ||
    b.type === "scheduled_list" ||
    b.type === "recurring_candidates" ||
    b.type === "transaction_detail" ||
    b.type === "category_list" ||
    b.type === "goals_list" ||
    b.type === "goal_detail" ||
    b.type === "goal_form_card" ||
    b.type === "plan_proposal_card"
  );
}

function isInlineCardBlock(b: Block): boolean {
  return isCardBlock(b);
}

function hasDetailButtonForBlock(b: Block): boolean {
  return detailRouteForBlock(b) !== null || b.type === "categorize_confirm_card";
}

/** Best-effort POST /chat/threads/:id/read. We never block the UI on
 *  this; a failed call just means the unread count drops on the next
 *  poll. Silently swallow so chat keeps flowing even when /read is
 *  slow or unreachable. */
function markRead(threadId: string): void {
  apiFetch(`/chat/threads/${threadId}/read`, { method: "POST" }).catch(() => {});
}

/** Surface a clear message when an intent consume is rejected because the
 *  user only has view access (editor required). Other errors stay silent —
 *  the card action is best-effort and the user can retry from chat. */
function notifyConsumeError(e: unknown): void {
  if (isApiError(e) && e.code === "insufficient_role") {
    Alert.alert("View-only access", "You don't have permission to make changes in this workspace.");
  }
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
  dismissedIntents,
  onDetailPress,
  onSupportPress,
  onAccept,
  onSubmitForm,
  onFormFocusChange,
  onOpenActivity,
  onChangeCategory,
  onDismissIntent,
}: {
  message: ChatMessageDTO;
  dismissedIntents: Set<string>;
  onDetailPress?: (block: Block, message: ChatMessageDTO) => void;
  onSupportPress?: (message: ChatMessageDTO) => void;
  onAccept?: (intent: string) => void;
  onSubmitForm?: (intentId: string, overrides: Record<string, unknown>) => Promise<void>;
  onFormFocusChange?: (focused: boolean) => void;
  onOpenActivity?: () => void;
  onChangeCategory?: (txId: string, onPicked: (cat: CategoryDTO | null) => void) => void;
  onDismissIntent?: (intentId: string) => void;
}) {
  const rawBlocks = Array.isArray(message.blocks) ? (message.blocks as Block[]) : [];
  // Drop confirm_card blocks whose intent the user already resolved
  // this session — once tapped, the card collapses out of the thread.
  // Other block types are unaffected.
  const blocks = rawBlocks.filter((b) => {
    if (b.type === "confirm_card" || b.type === "plan_proposal_card") {
      return !dismissedIntents.has(b.accept_intent);
    }
    return true;
  });
  const isUser = message.role === "user";
  const lastCardBlockIndex = blocks.reduce(
    (last, block, index) => (isCardBlock(block) ? index : last),
    -1,
  );
  const hasCardBlocks = lastCardBlockIndex !== -1;
  const [actionRowWidth, setActionRowWidth] = useState(
    hasCardBlocks ? DETAIL_BLOB_MIN_WIDTH : SUPPORT_ACTION_MIN_WIDTH,
  );
  const lastTextBlockIndex = blocks.reduce(
    (last, block, index) => (!isCardBlock(block) ? index : last),
    -1,
  );
  const shareText = assistantCopyText(message);
  const hasAssistantShareAction = message.role === "assistant" && shareText.length > 0;
  const hasAssistantSupportAction = message.role === "assistant" && !!onSupportPress;
  const hasAssistantAction = hasAssistantShareAction || hasAssistantSupportAction;
  const actionRowWidthStyle =
    !isUser && (hasCardBlocks || hasAssistantAction) ? { width: actionRowWidth } : null;

  useEffect(() => {
    setActionRowWidth(hasCardBlocks ? DETAIL_BLOB_MIN_WIDTH : SUPPORT_ACTION_MIN_WIDTH);
  }, [hasCardBlocks, message.id]);

  const captureActionBubbleWidth = useCallback(
    (event: LayoutChangeEvent) => {
      if (isUser) return;
      const minWidth = hasCardBlocks ? DETAIL_BLOB_MIN_WIDTH : SUPPORT_ACTION_MIN_WIDTH;
      const nextWidth = Math.max(minWidth, Math.ceil(event.nativeEvent.layout.width));
      setActionRowWidth((current) => (Math.abs(current - nextWidth) < 1 ? current : nextWidth));
    },
    [hasCardBlocks, isUser],
  );
  const handleDetailPress = (block: Block, msg: ChatMessageDTO) => {
    onDetailPress?.(block, msg);
  };
  const handleShare = useCallback(async () => {
    const text = assistantCopyText(message);
    if (!text) return;
    try {
      const mode = await copyTextToClipboard(text);
      if (mode === "clipboard") {
        Alert.alert("Copied", "Answer copied to clipboard.");
      }
    } catch (e) {
      Alert.alert("Couldn't copy", e instanceof Error ? e.message : "Try again.");
    }
  }, [message]);
  const renderShareButton = (density: "default" | "compact" = "default") => {
    if (!hasAssistantShareAction) return null;
    return (
      <Pressable
        onPress={handleShare}
        accessibilityRole="button"
        accessibilityLabel="Copy answer"
        hitSlop={8}
        style={({ pressed }) => [
          styles.supportAction,
          density === "compact"
            ? styles.supportActionInSupportOnlyRow
            : styles.supportActionInDetailRow,
          pressed && { opacity: 0.65 },
        ]}
      >
        <Ionicons name="copy-outline" size={SUPPORT_ACTION_ICON_SIZE} color={colors.muted} />
      </Pressable>
    );
  };
  const renderSupportButton = (density: "default" | "compact" = "default") => {
    if (!hasAssistantSupportAction) return null;
    return (
      <Pressable
        onPress={() => onSupportPress?.(message)}
        accessibilityRole="button"
        accessibilityLabel="Report this answer"
        hitSlop={8}
        style={({ pressed }) => [
          styles.supportAction,
          density === "compact"
            ? styles.supportActionInSupportOnlyRow
            : styles.supportActionInDetailRow,
          pressed && { opacity: 0.65 },
        ]}
      >
        <Ionicons name="help-circle-outline" size={SUPPORT_ACTION_ICON_SIZE} color={colors.muted} />
      </Pressable>
    );
  };

  // Render each block as its own visual row. Text blocks get the standard
  // chat bubble; card blocks render full-width (within the list padding)
  // so the structured surface treatment from BlockCard / confirm card
  // can carry without an outer rounded bubble fighting it.
  return (
    <View style={{ gap: 6 }}>
      {blocks.map((b, i) => {
        const key = `${message.id}-${i}`;
        if (isInlineCardBlock(b)) {
          const showDetailButton = hasDetailButtonForBlock(b);
          const showActionsInDetailRow =
            message.role === "assistant" && i === lastCardBlockIndex && hasAssistantAction;
          return (
            <Fragment key={key}>
              <View style={[styles.cardRow, isUser ? styles.rowUser : styles.rowAssistant]}>
                <PresentationBlock
                  block={b}
                  role={message.role}
                  {...(onAccept ? { onAccept } : {})}
                  onReject={(intent) => {
                    if (b.type === "confirm_card" || b.type === "plan_proposal_card") {
                      onDismissIntent?.(b.accept_intent);
                    }
                    if (intent) onDismissIntent?.(intent);
                  }}
                  {...(onSubmitForm ? { onSubmitForm } : {})}
                  {...(onFormFocusChange ? { onFormFocusChange } : {})}
                  {...(onOpenActivity ? { onOpenActivity } : {})}
                  {...(onChangeCategory ? { onChangeCategory } : {})}
                />
              </View>
              {showDetailButton || showActionsInDetailRow ? (
                <View
                  style={[
                    styles.detailActionRow,
                    !showDetailButton && styles.supportOnlyActionRow,
                    actionRowWidthStyle,
                  ]}
                >
                  {showDetailButton ? (
                    <Pressable
                      onPress={() => handleDetailPress(b, message)}
                      accessibilityRole="button"
                      accessibilityLabel="View message detail"
                      style={({ pressed }) => [styles.detailButton, pressed && { opacity: 0.72 }]}
                    >
                      <Ionicons name="reader-outline" size={16} color={colors.primary} />
                      <Text style={styles.detailButtonText}>{detailLabelForBlock(b)}</Text>
                    </Pressable>
                  ) : null}
                  {showActionsInDetailRow ? (
                    <View style={styles.messageActionGroup}>
                      {renderShareButton()}
                      {renderSupportButton()}
                    </View>
                  ) : null}
                </View>
              ) : null}
            </Fragment>
          );
        }
        const showSupportOnlyRow =
          hasAssistantAction && lastCardBlockIndex === -1 && i === lastTextBlockIndex;
        const shouldCaptureActionBubbleWidth =
          !isUser && i === lastTextBlockIndex && (hasCardBlocks || hasAssistantAction);
        return (
          <Fragment key={key}>
            <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
              <View
                onLayout={shouldCaptureActionBubbleWidth ? captureActionBubbleWidth : undefined}
                style={[
                  styles.bubble,
                  isUser ? styles.bubbleUser : styles.bubbleAssistant,
                  !isUser && hasCardBlocks && styles.assistantBubbleWithDetailActions,
                  !isUser &&
                    hasAssistantAction &&
                    !hasCardBlocks &&
                    styles.assistantBubbleWithSupportActions,
                ]}
              >
                <PresentationBlock block={b} role={message.role} />
              </View>
            </View>
            {showSupportOnlyRow ? (
              <View
                style={[styles.detailActionRow, styles.supportOnlyActionRow, actionRowWidthStyle]}
              >
                {renderShareButton("compact")}
                {renderSupportButton("compact")}
              </View>
            ) : null}
          </Fragment>
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
  olderLoader: { paddingVertical: space.md, alignItems: "center" },
  row: { flexDirection: "row", marginVertical: 4 },
  rowUser: { justifyContent: "flex-end" },
  rowAssistant: { justifyContent: "flex-start" },
  cardRow: { width: "100%", marginVertical: 2 },
  assistantBubbleWithDetailActions: {
    minWidth: DETAIL_BLOB_MIN_WIDTH,
  },
  assistantBubbleWithSupportActions: {
    minWidth: SUPPORT_ACTION_MIN_WIDTH,
  },
  detailActionRow: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    justifyContent: "space-between",
    gap: space.xs,
    minWidth: DETAIL_BLOB_MIN_WIDTH,
    maxWidth: "82%",
    marginVertical: 2,
  },
  supportOnlyActionRow: {
    alignItems: "flex-start",
    justifyContent: "flex-end",
    minWidth: SUPPORT_ACTION_MIN_WIDTH,
  },
  messageActionGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
  },
  detailButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 36,
    paddingHorizontal: space.sm,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.canvas,
  },
  detailButtonText: {
    ...type$.button,
    fontSize: 14,
    lineHeight: 16,
    color: colors.primary,
  },
  supportAction: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 2,
    paddingVertical: 1,
  },
  supportActionInDetailRow: {
    minWidth: SUPPORT_ACTION_ICON_SIZE,
    minHeight: 36,
    paddingHorizontal: 0,
    justifyContent: "center",
  },
  supportActionInSupportOnlyRow: {
    minWidth: SUPPORT_ACTION_ICON_SIZE,
    minHeight: 18,
    paddingHorizontal: 0,
    paddingVertical: 0,
    alignItems: "center",
    justifyContent: "flex-start",
  },
  bubble: {
    maxWidth: "82%",
    paddingHorizontal: space.base,
    paddingVertical: 10,
    borderRadius: 18,
  },
  bubbleUser: { backgroundColor: colors.primary, borderBottomRightRadius: 4 },
  bubbleAssistant: { backgroundColor: colors.surfaceSoft, borderBottomLeftRadius: 4 },
  grabber: { backgroundColor: colors.hairline, width: 36, height: 4 },
  sheetBackground: { backgroundColor: colors.canvas },
  detailSheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.lg,
    paddingTop: 8,
    paddingBottom: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  detailHeaderSide: {
    width: 72,
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
  },
  detailHeaderRight: { justifyContent: "flex-end" },
  detailSheetTitle: {
    ...type$.titleSm,
    color: colors.ink,
    flex: 1,
    textAlign: "center",
  },
  detailHeaderAction: {
    minHeight: 36,
    justifyContent: "center",
  },
  detailHeaderActionText: { ...type$.button, color: colors.muted },
  detailHeaderSaveText: { ...type$.button, color: colors.primary },
  detailHeaderDisabled: {
    opacity: 0.42,
  },
  detailSheetContent: { padding: space.lg, paddingBottom: space.xl },
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
  startSuggestion: {
    alignSelf: "flex-start",
    marginTop: space.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.canvas,
  },
  startSuggestionText: { ...type$.bodySm, color: colors.primary, fontWeight: "600" },
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
  modalAvoid: { flex: 1 },
  categoryPickerModal: { flex: 1 },
  modalBackdrop: {
    flex: 1,
    justifyContent: "center",
    padding: space.lg,
    backgroundColor: "rgba(17, 24, 39, 0.36)",
  },
  supportModal: {
    backgroundColor: colors.canvas,
    borderRadius: 14,
    padding: space.base,
    gap: space.sm,
  },
  supportTitle: { ...type$.titleMd, color: colors.ink },
  supportInput: {
    minHeight: 128,
    paddingHorizontal: space.sm + 2,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surfaceSoft,
    color: colors.ink,
    fontSize: 16,
  },
  supportErr: { ...type$.caption, color: colors.down },
  supportActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: space.xs,
  },
  supportBtn: {
    minWidth: 86,
    minHeight: 42,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.base,
  },
  supportBtnSecondary: {
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.canvas,
  },
  supportBtnPrimary: { backgroundColor: colors.primary },
  supportBtnSecondaryText: { ...type$.button, color: colors.ink },
  supportBtnPrimaryText: { ...type$.button, color: colors.onPrimary },
});
