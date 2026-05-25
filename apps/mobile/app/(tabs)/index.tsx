import { useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator, Animated } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { displayName, trialDaysLeft, type MeDTO as Me } from "@fina/shared";
import { useSession } from "../../src/auth/client";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { useCollapsingHeader } from "../../src/design/useCollapsingHeader";

const HEADER_HEIGHT = 84;

type ChecklistItem = {
  id: "set-budget" | "connect-bank" | "set-goal" | "morning-brief";
  title: string;
  subtitle: string;
  cta: string;
  href: string;
  done: boolean;
};

export default function Home() {
  const { data: session } = useSession();
  const [me, setMe] = useState<Me | null>(null);
  const [bankCount, setBankCount] = useState<number | null>(null);
  const [hasBudget, setHasBudget] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const activeId = await bootstrapActiveWorkspace();
        const meData = await apiFetch<Me>("/me");
        if (cancelled) return;
        setMe(meData);
        if (activeId) {
          try {
            const banks = await apiFetch<{ plaidItems: unknown[] }>(
              `/workspaces/${activeId}/plaid-items`,
            );
            if (!cancelled) setBankCount(banks.plaidItems.length);
          } catch {
            if (!cancelled) setBankCount(0);
          }
          try {
            const def = await apiFetch<{ plan: unknown }>(
              `/workspaces/${activeId}/budget-plans/default`,
            );
            if (!cancelled) setHasBudget(def.plan !== null);
          } catch {
            if (!cancelled) setHasBudget(false);
          }
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const greetingName =
    session?.user && me?.user
      ? displayName({ name: me.user.name, email: me.user.email })
      : "";

  const days = me?.trial?.endsAt ? trialDaysLeft(me.trial.endsAt) : null;

  const checklist: ChecklistItem[] = [
    {
      id: "set-budget",
      title: "Set a monthly budget",
      subtitle:
        "Pick a total — Fina tracks every spend against it and can suggest a category split.",
      cta: "Set budget",
      href: "/budget",
      done: hasBudget === true,
    },
    {
      id: "connect-bank",
      title: "Connect a bank",
      subtitle: "Plaid securely imports your transactions.",
      cta: "Connect",
      href: "/banks",
      done: bankCount !== null && bankCount > 0,
    },
    {
      id: "morning-brief",
      title: "Try your first morning brief",
      subtitle: "Tap Chat to see what Fina has to say about today.",
      cta: "Open chat",
      href: "/(tabs)/chat",
      done: false,
    },
    {
      id: "set-goal",
      title: "Set your first goal",
      subtitle: "Save for something. Pro feature, free during trial.",
      cta: "Set goal",
      href: "/(tabs)/goals",
      done: false,
    },
  ];

  const insets = useSafeAreaInsets();
  const totalHeader = insets.top + HEADER_HEIGHT;
  const header = useCollapsingHeader(HEADER_HEIGHT);

  return (
    <View style={styles.safe}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: totalHeader }]}
        onScroll={header.onScroll}
        scrollEventThrottle={header.scrollEventThrottle}
      >
        {me?.trial?.active && days !== null && (
          <View style={styles.trialBanner}>
            <Ionicons name="sparkles" size={16} color={colors.navy} />
            <Text style={styles.trialBannerText}>
              Pro trial · {days} day{days === 1 ? "" : "s"} left
            </Text>
          </View>
        )}

        {!me && !err && (
          <View style={{ paddingVertical: space.xxl }}>
            <ActivityIndicator color={colors.primary} />
          </View>
        )}

        {err && (
          <View style={styles.errCard}>
            <Text style={styles.errTitle}>Couldn't reach Fina</Text>
            <Text style={styles.errBody}>{err}</Text>
          </View>
        )}

        {me && (
          <>
            <Text style={styles.sectionTitle}>Get started</Text>
            {checklist.map((item) => (
              <Pressable
                key={item.id}
                style={({ pressed }) => [
                  styles.card,
                  pressed && { opacity: 0.7 },
                ]}
                onPress={() => router.push(item.href as never)}
              >
                <View style={styles.cardLeft}>
                  <View style={[styles.cardGlyph, item.done && styles.cardGlyphDone]}>
                    <Ionicons
                      name={item.done ? "checkmark" : "arrow-forward"}
                      size={18}
                      color={item.done ? colors.onPrimary : colors.primary}
                    />
                  </View>
                </View>
                <View style={styles.cardBody}>
                  <Text style={[styles.cardTitle, item.done && styles.cardTitleDone]}>
                    {item.title}
                  </Text>
                  <Text style={styles.cardSub}>{item.subtitle}</Text>
                </View>
                <Text style={styles.cardCta}>{item.cta}</Text>
              </Pressable>
            ))}
          </>
        )}
      </ScrollView>
      <Animated.View
        style={[
          styles.headerOverlay,
          { top: insets.top, height: HEADER_HEIGHT },
          header.headerStyle,
        ]}
      >
        <View style={styles.head}>
          <View>
            <Text style={styles.title} numberOfLines={1}>
              Hi{greetingName ? `, ${greetingName}` : ""}
            </Text>
            <Text style={styles.subtitle}>Welcome to Fina.</Text>
          </View>
        </View>
      </Animated.View>
      <View style={[styles.statusBarBg, { height: insets.top }]} />
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
  head: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingTop: 12,
    height: HEADER_HEIGHT,
  },
  title: { ...type$.titleLg, color: colors.ink },
  subtitle: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  scroll: { padding: space.lg, paddingBottom: space.xxl },
  trialBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(143, 184, 232, 0.18)",
    paddingHorizontal: space.base,
    paddingVertical: space.sm,
    borderRadius: 999,
    alignSelf: "flex-start",
    marginBottom: space.lg,
  },
  trialBannerText: {
    ...type$.captionStrong,
    color: colors.navy,
  },
  errCard: {
    backgroundColor: colors.surfaceSoft,
    padding: space.base,
    borderRadius: 14,
    marginVertical: space.base,
  },
  errTitle: { ...type$.titleSm, color: colors.down, marginBottom: 4 },
  errBody: { ...type$.bodySm, color: colors.body },
  sectionTitle: {
    ...type$.captionStrong,
    color: colors.muted,
    textTransform: "uppercase",
    marginBottom: space.sm,
    marginTop: space.base,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 16,
    padding: space.base,
    marginBottom: space.sm,
    gap: space.sm,
  },
  cardLeft: {},
  cardGlyph: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  cardGlyphDone: {
    backgroundColor: colors.primary,
  },
  cardBody: { flex: 1 },
  cardTitle: { ...type$.titleSm, color: colors.ink },
  cardTitleDone: { color: colors.muted, textDecorationLine: "line-through" },
  cardSub: { ...type$.bodySm, color: colors.body, marginTop: 2 },
  cardCta: { ...type$.captionStrong, color: colors.primary, paddingLeft: 4 },
});
