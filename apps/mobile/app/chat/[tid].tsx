import { View, Text, StyleSheet, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ThreadView } from "../../src/chat/ThreadView";
import { colors, space, type as type$ } from "../../src/design/tokens";

// Drill-in detail for a specific (usually historical) thread, opened
// from /chats. The Chat tab itself uses ThreadView inline for the
// current thread — see app/(tabs)/chat.tsx.
export default function ChatDetail() {
  const { tid } = useLocalSearchParams<{ tid: string }>();

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <Pressable
          style={({ pressed }) => [styles.headerBtn, pressed && { opacity: 0.5 }]}
          onPress={() => router.back()}
          hitSlop={8}
        >
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Chat</Text>
        <View style={styles.headerBtn} />
      </View>
      {tid && <ThreadView threadId={tid} />}
    </SafeAreaView>
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
  headerBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerTitle: { ...type$.titleSm, color: colors.ink },
});
