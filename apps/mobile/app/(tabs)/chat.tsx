import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, Animated, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, router, useNavigation } from "expo-router";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { ThreadView } from "../../src/chat/ThreadView";
import { ThreadActionsSheet } from "../../src/chat/ThreadActionsSheet";
import { apiFetch } from "../../src/api/client";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
import { useCollapsingHeader } from "../../src/design/useCollapsingHeader";

const HEADER_HEIGHT = 58;

// Tapping the Chat tab always lands on a fresh, pending thread (no DB
// row). The thread is created lazily on the user's first send — until
// then nothing persists. Historical conversations live in /chats.
export default function ChatTab() {
  const params = useLocalSearchParams<{ thread?: string }>();
  const navigation = useNavigation();
  const tabBarHeight = useBottomTabBarHeight();
  const insets = useSafeAreaInsets();
  const totalHeader = insets.top + HEADER_HEIGHT;
  const header = useCollapsingHeader(HEADER_HEIGHT);
  // null = pending; a real id appears only when /chats explicitly
  // routes the user back to a specific thread via ?thread=<id>.
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  // Force ThreadView to fully reset (new keyed instance) when the
  // pencil is hit while already on the pending state.
  const [resetKey, setResetKey] = useState(0);
  // Workspace tag shown in the header, fed by ThreadView's binding /
  // picker state. Null when user has a single workspace (no tag needed).
  const [headerWorkspace, setHeaderWorkspace] = useState<string | null>(null);
  // Loaded thread for the header — null on the pending state. Drives the
  // title text and whether the header is tappable for rename/delete.
  const [headerThread, setHeaderThread] = useState<{
    id: string;
    title: string | null;
  } | null>(null);
  const [actionsVisible, setActionsVisible] = useState(false);

  useEffect(() => {
    if (params.thread) {
      setCurrentThreadId(params.thread);
      // Switching threads needs the collapsible header snapped back —
      // the new ThreadView mounts at scrollY 0, but the hook still
      // holds translateY from the previous thread's scroll position.
      header.reset();
      router.setParams({ thread: undefined } as never);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.thread]);

  useEffect(() => {
    if (!params.thread) return;
    apiFetch(`/chat/threads/${params.thread}/read`, { method: "POST" }).catch(() => {
      // swallow — read mark is best-effort
    });
  }, [params.thread]);

  const onNewChat = useCallback(() => {
    setCurrentThreadId(null);
    setResetKey((k) => k + 1);
    setHeaderThread(null);
    setActionsVisible(false);
    header.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tapping the Chat tab while already on it should reset to a new
  // (pending) thread. tabPress fires for every tap; we trigger only
  // when the tab was ALREADY focused — switching from another tab
  // is handled by normal navigation focus.
  useEffect(() => {
    const unsub = navigation.addListener("tabPress" as never, (() => {
      if ((navigation as { isFocused: () => boolean }).isFocused()) {
        onNewChat();
      }
    }) as never);
    return unsub;
  }, [navigation, onNewChat]);

  return (
    <View style={styles.safe}>
      <ThreadView
        key={`${currentThreadId ?? "pending"}-${resetKey}`}
        threadId={currentThreadId}
        bottomInset={tabBarHeight}
        onScroll={header.onScroll}
        scrollEventThrottle={header.scrollEventThrottle}
        listTopInset={totalHeader}
        onWorkspaceContextChange={({ workspaceName, multipleWorkspaces }) => {
          setHeaderWorkspace(multipleWorkspaces ? workspaceName : null);
        }}
        onThreadChange={setHeaderThread}
      />
      <Animated.View style={[styles.headerOverlay, { top: insets.top, height: HEADER_HEIGHT }, header.headerStyle]}>
        <View style={styles.header}>
          <HeaderIconButton
            icon="time-outline"
            variant="plain"
            accessibilityLabel="Chat history"
            onPress={() => router.push("/chats" as never)}
          />
          <Pressable
            style={styles.headerCenter}
            disabled={!headerThread}
            onPress={() => headerThread && setActionsVisible(true)}
            hitSlop={8}
          >
            <View style={styles.headerTitleRow}>
              <Text style={styles.headerTitle} numberOfLines={1} ellipsizeMode="tail">
                {headerThread?.title?.trim() || "Chat"}
              </Text>
              {headerThread ? (
                <Ionicons
                  name="chevron-down"
                  size={14}
                  color={colors.muted}
                  style={styles.headerCaret}
                />
              ) : null}
            </View>
            {headerWorkspace ? (
              <Text style={styles.headerWorkspace} numberOfLines={1}>
                {headerWorkspace}
              </Text>
            ) : null}
          </Pressable>
          <HeaderIconButton
            icon="create-outline"
            variant="plain"
            accessibilityLabel="New chat"
            onPress={onNewChat}
          />
        </View>
      </Animated.View>
      <View style={[styles.statusBarBg, { height: insets.top }]} />
      {headerThread ? (
        <ThreadActionsSheet
          visible={actionsVisible}
          threadId={headerThread.id}
          currentTitle={headerThread.title}
          onRenamed={(newTitle) =>
            setHeaderThread((prev) =>
              prev ? { ...prev, title: newTitle } : prev,
            )
          }
          onDeleted={onNewChat}
          onClose={() => setActionsVisible(false)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  headerOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 10,
    backgroundColor: colors.canvas,
  },
  statusBarBg: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 11,
    backgroundColor: colors.canvas,
  },
  header: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.base,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  headerCenter: {
    flex: 1,
    alignItems: "center",
    paddingHorizontal: space.sm,
  },
  headerTitleRow: { flexDirection: "row", alignItems: "center", maxWidth: "100%" },
  headerTitle: { ...type$.titleSm, color: colors.ink, flexShrink: 1 },
  headerCaret: { marginLeft: 4 },
  headerWorkspace: { ...type$.caption, color: colors.muted, marginTop: 1 },
});
