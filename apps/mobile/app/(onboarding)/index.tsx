import { useRef, useState } from "react";
import {
  Dimensions,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { colors, type } from "../../src/design/tokens";
import { Icon } from "../../src/design/Icon";
import { ONBOARDING_SEEN_KEY } from "../../src/onboarding/storage";

type Slide = {
  title: string;
  sub: string;
  illustration: React.ReactNode;
};

const { width: screenWidth } = Dimensions.get("window");

export default function Onboarding() {
  const scrollRef = useRef<ScrollView>(null);
  const [index, setIndex] = useState(0);

  const slides: Slide[] = [
    {
      title: "Every morning, before you open your wallet.",
      sub: "Fina checks yesterday, flags what matters, and asks for one tap to sort the rest.",
      illustration: <MorningBriefIllustration />,
    },
    {
      title: "Talk it over with Fina.",
      sub: "Should we cancel Netflix? Can we afford the trip? Fina knows your numbers and helps you decide.",
      illustration: <ChatIllustration />,
    },
    {
      title: "Money is a household thing.",
      sub: "Invite your partner or family. See the same numbers, no spreadsheets. Free, forever.",
      illustration: <WorkspaceIllustration />,
    },
  ];

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(e.nativeEvent.contentOffset.x / screenWidth);
    if (next !== index) setIndex(next);
  };

  const dismiss = async () => {
    await AsyncStorage.setItem(ONBOARDING_SEEN_KEY, "1");
  };

  const onSkip = async () => {
    await dismiss();
    router.replace("/(auth)/sign-in");
  };

  const onCreate = async () => {
    await dismiss();
    router.replace("/(auth)/sign-up");
  };

  const onSignIn = async () => {
    await dismiss();
    router.replace("/(auth)/sign-in");
  };

  return (
    <SafeAreaView style={styles.root}>
      <Pressable onPress={onSkip} style={styles.skip} hitSlop={12}>
        <Text style={styles.skipText}>Skip</Text>
      </Pressable>

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScroll}
        contentContainerStyle={{ flexGrow: 1 }}
      >
        {slides.map((s, i) => (
          <View key={i} style={[styles.slide, { width: screenWidth }]}>
            <View style={styles.illoBox}>{s.illustration}</View>
            <Text style={styles.title}>{s.title}</Text>
            <Text style={styles.sub}>{s.sub}</Text>
          </View>
        ))}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable style={styles.cta} onPress={onCreate}>
          <Text style={styles.ctaText}>Create account</Text>
        </Pressable>
        <View style={styles.dots}>
          {slides.map((_, i) => (
            <View
              key={i}
              style={[styles.dot, i === index && styles.dotActive]}
            />
          ))}
        </View>
        <View style={styles.footRow}>
          <Text style={styles.footText}>Already have an account? </Text>
          <Pressable onPress={onSignIn} hitSlop={8}>
            <Text style={styles.footLink}>Sign in</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

function MorningBriefIllustration() {
  return (
    <View style={illoStyles.inner}>
      <View style={illoStyles.headerRow}>
        <View style={illoStyles.headerDot} />
        <Text style={illoStyles.headerText}>FINA · MORNING BRIEF</Text>
      </View>
      <View style={illoStyles.bubble}>
        <Text style={illoStyles.bubbleText}>
          Morning. Yesterday came to <Text style={{ fontWeight: "700" }}>$214.83</Text>.
        </Text>
      </View>
      <View style={illoStyles.card}>
        <View style={illoStyles.cartIcon}>
          <Icon name="cart" size={14} color={colors.primary} strokeWidth={1.8} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={illoStyles.cardTitle}>Costco</Text>
          <Text style={illoStyles.cardSub}>$87.43 · Groceries?</Text>
        </View>
        <View style={illoStyles.checkPill}>
          <Icon name="check" size={14} color="#fff" strokeWidth={2.4} />
        </View>
      </View>
    </View>
  );
}

function ChatIllustration() {
  return (
    <View style={illoStyles.inner}>
      <View style={illoStyles.headerRow}>
        <View style={illoStyles.headerDot} />
        <Text style={illoStyles.headerText}>FINA · CHAT</Text>
      </View>
      <View style={[illoStyles.bubble, illoStyles.bubbleUser]}>
        <Text style={[illoStyles.bubbleText, { color: "#fff" }]}>
          Can we afford Japan in November?
        </Text>
      </View>
      <View style={illoStyles.bubble}>
        <Text style={illoStyles.bubbleText}>
          Almost. Trim <Text style={{ fontWeight: "700" }}>$80/mo</Text> on dining and you&apos;re there by <Text style={{ fontWeight: "700" }}>Nov 12</Text>.
        </Text>
      </View>
      <View style={illoStyles.card}>
        <View style={[illoStyles.cartIcon, { backgroundColor: "rgba(59,123,255,0.12)" }]}>
          <Icon name="sparkle" size={14} color={colors.primary} strokeWidth={2} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={illoStyles.cardTitle}>Japan trip · plan</Text>
          <Text style={illoStyles.cardSub}>Target $2,400 · 6 months</Text>
        </View>
        <Text style={[illoStyles.cardSub, { color: colors.up, fontWeight: "600" }]}>On track</Text>
      </View>
      <View style={illoStyles.progressTrack}>
        <View style={[illoStyles.progressFill, { width: "62%" }]} />
      </View>
    </View>
  );
}

function WorkspaceIllustration() {
  const members = [
    { name: "Brian Choi", role: "Owner · you", bg: colors.primary, initials: "BC" },
    { name: "Joelle Choi", role: "Editor · active", bg: "#2a7c8c", initials: "JC" },
  ];
  return (
    <View style={[illoStyles.wsCard]}>
      <View style={illoStyles.wsHeader}>
        <View>
          <Text style={illoStyles.headerText}>WORKSPACE</Text>
          <Text style={illoStyles.wsName}>Choi family</Text>
        </View>
        <View style={illoStyles.wsBadge}>
          <Text style={illoStyles.wsBadgeText}>2 members</Text>
        </View>
      </View>
      <View>
        {members.map((m) => (
          <View key={m.initials} style={illoStyles.wsMember}>
            <View style={[illoStyles.avatar, { backgroundColor: m.bg }]}>
              <Text style={illoStyles.avatarText}>{m.initials}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={illoStyles.cardTitle}>{m.name}</Text>
              <Text style={illoStyles.cardSub}>{m.role}</Text>
            </View>
            <Icon name="check" size={14} color={colors.muted} strokeWidth={1.8} />
          </View>
        ))}
      </View>
      <View style={illoStyles.wsFooter}>
        <Text style={illoStyles.headerText}>THIS MONTH, TOGETHER</Text>
        <Text style={illoStyles.wsAmount}>$1,847</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  skip: {
    position: "absolute",
    top: 60,
    right: 24,
    zIndex: 5,
    padding: 4,
  },
  skipText: { ...type.bodySm, color: colors.muted },
  slide: {
    paddingHorizontal: 28,
    paddingTop: 80,
    flex: 1,
  },
  illoBox: {
    flex: 1,
    borderRadius: 28,
    backgroundColor: colors.surfaceSoft,
    overflow: "hidden",
    padding: 22,
    justifyContent: "flex-end",
  },
  title: {
    ...type.displaySm,
    color: colors.ink,
    marginTop: 28,
  },
  sub: {
    ...type.bodyMd,
    color: colors.body,
    marginTop: 10,
  },
  footer: {
    paddingHorizontal: 28,
    paddingBottom: 0,
    paddingTop: 24,
  },
  cta: {
    height: 52,
    borderRadius: 999,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  ctaText: { ...type.button, color: "#fff" },
  dots: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
    marginTop: 18,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 999,
    backgroundColor: colors.hairline,
  },
  dotActive: {
    width: 22,
    backgroundColor: colors.ink,
  },
  footRow: {
    flexDirection: "row",
    justifyContent: "center",
    marginTop: 14,
  },
  footText: { ...type.bodySm, color: colors.muted },
  footLink: { ...type.bodySm, color: colors.primary, fontWeight: "600" },
});

const illoStyles = StyleSheet.create({
  inner: {
    flex: 1,
    justifyContent: "flex-end",
    gap: 10,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  headerDot: {
    width: 6,
    height: 6,
    borderRadius: 999,
    backgroundColor: colors.primary,
  },
  headerText: {
    ...type.captionStrong,
    color: colors.ink,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  bubble: {
    backgroundColor: "#fff",
    padding: 12,
    paddingHorizontal: 14,
    borderRadius: 18,
    borderBottomLeftRadius: 6,
    borderWidth: 1,
    borderColor: colors.hairline,
    maxWidth: "94%",
  },
  bubbleUser: {
    alignSelf: "flex-end",
    backgroundColor: colors.primary,
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 6,
    borderColor: colors.primary,
  },
  bubbleText: { ...type.bodySm, color: colors.ink },
  card: {
    backgroundColor: "#fff",
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.hairline,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  cartIcon: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: "rgba(59,123,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: { ...type.bodySm, fontWeight: "600", color: colors.ink },
  cardSub: { fontSize: 11, color: colors.muted, marginTop: 1 },
  checkPill: {
    width: 28,
    height: 28,
    borderRadius: 999,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  progressTrack: {
    height: 6,
    borderRadius: 999,
    backgroundColor: colors.surfaceStrong,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: colors.primary,
    borderRadius: 999,
  },
  wsCard: {
    backgroundColor: "#fff",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.hairline,
    overflow: "hidden",
  },
  wsHeader: {
    padding: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "#ececec",
  },
  wsName: { ...type.bodyMd, fontWeight: "600", color: colors.ink, marginTop: 2 },
  wsBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: "rgba(5,177,105,0.12)",
  },
  wsBadgeText: { fontSize: 11, fontWeight: "600", color: "#1e7d36", letterSpacing: 0.2 },
  wsMember: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 10,
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 12, fontWeight: "700", letterSpacing: 0.3 },
  wsFooter: {
    padding: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: "#ececec",
  },
  wsAmount: { fontSize: 17, fontWeight: "600", color: colors.ink, letterSpacing: -0.3 },
});
