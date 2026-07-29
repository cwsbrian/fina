import { useCallback, useState } from "react";
import { ActivityIndicator, Animated, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ChatThreadDTO, MeDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspaceSummary } from "../../src/api/client";
import { PaidFeatureLock } from "../../src/billing/PaidFeatureLock";
import { ThreadView } from "../../src/chat/ThreadView";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { useCollapsingHeader } from "../../src/design/useCollapsingHeader";

const HEADER_HEIGHT = 58;

export default function ChatTab() {
  const params = useLocalSearchParams<{ thread?: string }>();
  const insets = useSafeAreaInsets();
  const totalHeader = insets.top + HEADER_HEIGHT;
  const header = useCollapsingHeader(HEADER_HEIGHT);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [paid, setPaid] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setError(null);
      (async () => {
        try {
          const me = await apiFetch<MeDTO>("/me");
          if (cancelled) return;
          const canChat = me.tier === "pro" || me.tier === "max" || me.trial.active;
          setPaid(canChat);
          if (!canChat) {
            setThreadId(null);
            return;
          }

          if (params.thread) {
            const existing = await apiFetch<{ thread: ChatThreadDTO }>(
              `/chat/threads/${params.thread}`,
            );
            if (!cancelled) setThreadId(existing.thread.id);
            return;
          }

          const workspace = await bootstrapActiveWorkspaceSummary();
          if (!workspace) throw new Error("no_workspace");
          const canonical = await apiFetch<{ thread: ChatThreadDTO }>("/chat/threads", {
            method: "POST",
            body: JSON.stringify({}),
          });
          if (cancelled) return;
          setWorkspaceName(workspace.name);
          setThreadId(canonical.thread.id);
        } catch (e) {
          if (!cancelled) {
            setError((e as { code?: string }).code ?? "load_error");
            setPaid((value) => value ?? true);
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [params.thread]),
  );

  const content =
    paid === false ? (
      <View style={[styles.content, { paddingTop: totalHeader }]}>
        <PaidFeatureLock
          title="Chat with Fina on Pro"
          body="Upgrade to ask questions about your spending, budgets, and financial goals."
          icon="chatbubble-ellipses-outline"
        />
      </View>
    ) : error ? (
      <View style={[styles.center, { paddingTop: totalHeader }]}>
        <Text style={styles.errorTitle}>Couldn't load chat</Text>
        <Text style={styles.errorBody}>{error}</Text>
      </View>
    ) : !threadId ? (
      <View style={[styles.center, { paddingTop: totalHeader }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    ) : (
      <ThreadView
        key={threadId}
        threadId={threadId}
        onScroll={header.onScroll}
        scrollEventThrottle={header.scrollEventThrottle}
        listTopInset={totalHeader}
        onWorkspaceContextChange={({ workspaceName: name }) => setWorkspaceName(name)}
      />
    );

  return (
    <View style={styles.safe}>
      {content}
      <Animated.View
        style={[
          styles.headerOverlay,
          { top: insets.top, height: HEADER_HEIGHT },
          header.headerStyle,
        ]}
      >
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Chat</Text>
          {workspaceName ? (
            <Text style={styles.headerWorkspace} numberOfLines={1}>
              {workspaceName}
            </Text>
          ) : null}
        </View>
      </Animated.View>
      <View style={[styles.statusBarBg, { height: insets.top }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  content: { flex: 1 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.xl,
  },
  errorTitle: { ...type$.titleMd, color: colors.down, marginBottom: 4 },
  errorBody: { ...type$.bodyMd, color: colors.body, textAlign: "center" },
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
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  headerTitle: { ...type$.titleSm, color: colors.ink },
  headerWorkspace: { ...type$.caption, color: colors.muted, marginTop: 1 },
});
