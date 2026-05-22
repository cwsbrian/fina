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
  Easing,
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
  threadId: string;
  /** Show inside the chat tab? (Bottom tab bar visible, no bottom safe-
   *  area edge — that's the tab bar's job.) When false (drill-in /
   *  history detail), the view manages its own bottom safe area. */
  embedded?: boolean;
};

type GetThreadResp = { thread: ChatThreadDTO; messages: ChatMessageDTO[] };
type PostMessageResp = { messages: ChatMessageDTO[] };

export function ThreadView({ threadId, embedded = false }: Props) {
  const [thread, setThread] = useState<ChatThreadDTO | null>(null);
  const [messages, setMessages] = useState<ChatMessageDTO[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList>(null);
  // Manual keyboard-driven padding — gives pixel-perfect sync with
  // the native keyboard animation. KeyboardAvoidingView's default
  // easing on iOS doesn't always match the keyboard frame timing,
  // which reads as a "snap" or lag depending on which leads. We
  // listen to keyboardWillShow/Hide (iOS) or keyboardDidShow/Hide
  // (Android — only Did fires there) and drive an Animated.Value
  // with the duration the OS reports for this specific keyboard.
  const keyboardPad = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const showEvt = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvt = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvt, (e) => {
      // On embedded (Chat tab) mode, the screen container already
      // sits above the tab bar (height ≈ 56 + safeBottom). The
      // keyboard covers that strip too, so we only need to add the
      // *extra* keyboard height beyond what the tab bar was occupying.
      const tabBarSlack = embedded ? 56 : 0;
      const target = Math.max(0, e.endCoordinates.height - tabBarSlack);
      Animated.timing(keyboardPad, {
        toValue: target,
        duration: e.duration ?? 250,
        easing: Easing.bezier(0.17, 0.59, 0.4, 0.77),
        useNativeDriver: false,
      }).start();
    });
    const hide = Keyboard.addListener(hideEvt, (e) => {
      Animated.timing(keyboardPad, {
        toValue: 0,
        duration: e.duration ?? 250,
        easing: Easing.bezier(0.17, 0.59, 0.4, 0.77),
        useNativeDriver: false,
      }).start();
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [embedded, keyboardPad]);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, []);

  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch<GetThreadResp>(`/chat/threads/${threadId}`);
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
  }, [threadId, scrollToBottom]);

  const onSend = async () => {
    const body = draft.trim();
    if (!body || sending || !threadId) return;
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
      const resp = await apiFetch<PostMessageResp>(
        `/chat/threads/${threadId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({ text: body, workspaceId: wsId }),
        },
      );
      setMessages((prev) => {
        const withoutTemp = prev.filter((m) => m.id !== tempId);
        return [...withoutTemp, ...resp.messages];
      });
      scrollToBottom();
    } catch (e) {
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setDraft(body);
      Alert.alert(
        "Couldn't send",
        (e as { code?: string }).code ?? "Try again in a moment.",
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

  if (!thread) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <Animated.View style={{ flex: 1, paddingBottom: keyboardPad }}>
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={scrollToBottom}
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
    </Animated.View>
  );
}

function MessageBubble({ message }: { message: ChatMessageDTO }) {
  const blocks = Array.isArray(message.blocks)
    ? (message.blocks as Block[])
    : [];
  const isUser = message.role === "user";
  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      <View
        style={[
          styles.bubble,
          isUser ? styles.bubbleUser : styles.bubbleAssistant,
        ]}
      >
        {blocks.map((b, i) => (
          <View key={i} style={i > 0 ? { marginTop: 8 } : undefined}>
            <PresentationBlock block={b} role={message.role} />
          </View>
        ))}
      </View>
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
