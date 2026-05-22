import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type {
  ChatMessageDTO,
  ChatThreadDTO,
  PresentationBlock as Block,
} from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { PresentationBlock } from "../../src/chat/PresentationBlock";
import { colors, space, type as type$ } from "../../src/design/tokens";

type GetThreadResp = { thread: ChatThreadDTO; messages: ChatMessageDTO[] };
type PostMessageResp = { messages: ChatMessageDTO[] };

export default function ChatDetail() {
  const { tid } = useLocalSearchParams<{ tid: string }>();
  const [thread, setThread] = useState<ChatThreadDTO | null>(null);
  const [messages, setMessages] = useState<ChatMessageDTO[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList>(null);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, []);

  // Load on mount + whenever tid changes.
  useEffect(() => {
    if (!tid) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch<GetThreadResp>(`/chat/threads/${tid}`);
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
  }, [tid, scrollToBottom]);

  const onSend = async () => {
    const body = draft.trim();
    if (!body || sending || !tid) return;
    setSending(true);
    setDraft("");
    // Optimistic user message — assistant reply replaces optimistic
    // entry on response (it's keyed by createdAt + role; the server's
    // version of the user message arrives along with the assistant
    // reply and we splice both in).
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
      // Ensure workspace is selected — chat needs workspace context.
      const wsId = (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");

      const resp = await apiFetch<PostMessageResp>(
        `/chat/threads/${tid}/messages`,
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
      // Roll back the optimistic message and surface the error.
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
      <SafeAreaView style={styles.safe}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.headerBtn}>
            <Ionicons name="chevron-back" size={22} color={colors.ink} />
          </Pressable>
          <Text style={styles.headerTitle}>Chat</Text>
          <View style={styles.headerBtn} />
        </View>
        <View style={styles.errBody}>
          <Text style={styles.errTitle}>Couldn't load chat</Text>
          <Text style={{ color: colors.body }}>{err}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.headerBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {thread?.title ?? "Chat"}
        </Text>
        <View style={styles.headerBtn} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 24}
      >
        {!thread && (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.primary} />
          </View>
        )}

        {thread && (
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
                  Tell Fina what's on your mind. "How am I doing this month?" is
                  a fine start.
                </Text>
              </View>
            }
            renderItem={({ item }) => (
              <MessageBubble message={item} />
            )}
          />
        )}

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
      </KeyboardAvoidingView>
    </SafeAreaView>
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
  safe: { flex: 1, backgroundColor: colors.canvas },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  headerBtn: { width: 38, height: 38, alignItems: "center", justifyContent: "center" },
  headerTitle: {
    ...type$.titleSm,
    color: colors.ink,
    flex: 1,
    textAlign: "center",
  },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  errBody: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.lg },
  errTitle: { ...type$.titleMd, color: colors.down, marginBottom: 4 },
  listContent: { padding: space.lg, gap: space.sm },
  row: {
    flexDirection: "row",
    marginVertical: 4,
  },
  rowUser: { justifyContent: "flex-end" },
  rowAssistant: { justifyContent: "flex-start" },
  bubble: {
    maxWidth: "82%",
    paddingHorizontal: space.base,
    paddingVertical: 10,
    borderRadius: 18,
  },
  bubbleUser: {
    backgroundColor: colors.primary,
    borderBottomRightRadius: 4,
  },
  bubbleAssistant: {
    backgroundColor: colors.surfaceSoft,
    borderBottomLeftRadius: 4,
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
