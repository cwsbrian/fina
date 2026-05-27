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
  Keyboard,
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
  // Skips the load useEffect's GET /chat/threads/:id when we just created
  // the thread locally during a send. Without this guard the GET races
  // the in-flight POST /messages: it returns empty messages (the POST
  // hasn't completed) and wipes the optimistic user bubble before the
  // server reply lands.
  const justCreatedId = useRef<string | null>(null);

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

  // Direct keyboard-driven padding — no animation. The view extends
  // to `bottomInset` above the screen edge (tab bar height in the
  // embedded case, 0 in the drill-in case), so the composer needs
  // raising by exactly `keyboardHeight - bottomInset`.
  const [keyboardPad, setKeyboardPad] = useState(0);

  useEffect(() => {
    const showEvt = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvt = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvt, (e) => {
      const target = Math.max(0, e.endCoordinates.height - bottomInset);
      setKeyboardPad(target);
    });
    const hide = Keyboard.addListener(hideEvt, () => {
      setKeyboardPad(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [bottomInset]);

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
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
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
      scrollToBottom();
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
    <View style={{ flex: 1, paddingBottom: keyboardPad }}>
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
        renderItem={({ item }) => <MessageBubble message={item} />}
        ListFooterComponent={sending ? <TypingIndicator /> : null}
      />

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
    </View>
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
    b.type === "confirm_card" ||
    b.type === "categorize_confirm_card"
  );
}

function MessageBubble({ message }: { message: ChatMessageDTO }) {
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
              <PresentationBlock block={b} role={message.role} />
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
});
