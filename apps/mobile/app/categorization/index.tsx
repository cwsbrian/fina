import { useEffect, useState } from "react";
import { ScrollView, View, Text, Pressable, StyleSheet, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { MeDTO, CategorizationMode } from "@fina/shared";
import { apiFetch } from "../../src/api/client";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";

const MODES: { key: CategorizationMode; title: string; sub: string }[] = [
  { key: "flexible", title: "Flexible", sub: "New merchants only need one confirm. Skipping is fine." },
  { key: "strict",   title: "Strict",   sub: "Every merchant needs a confirm before it auto-categorizes." },
  { key: "auto",     title: "Auto",     sub: "Never asks. Fix wrong categories yourself." },
];

export default function CategorizationSettings() {
  const [me, setMe] = useState<MeDTO | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch<MeDTO>("/me").then(setMe).catch(() => {});
  }, []);

  async function setMode(mode: CategorizationMode) {
    if (saving || !me) return;
    setSaving(true);
    try {
      const next = await apiFetch<MeDTO>("/me", {
        method: "PATCH",
        body: JSON.stringify({ categorizationMode: mode }),
      });
      setMe(next);
    } catch (e) {
      Alert.alert("Couldn't save", (e as { code?: string }).code ?? "Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <HeaderIconButton
          icon="chevron-back"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          variant="plain"
        />
        <Text style={styles.title}>Categorization style</Text>
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        {MODES.map((m) => {
          const selected = me?.user.categorizationMode === m.key;
          return (
            <Pressable
              key={m.key}
              style={[styles.card, selected && styles.cardSelected]}
              onPress={() => setMode(m.key)}
              disabled={saving}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>{m.title}</Text>
                <Text style={styles.cardSub}>{m.sub}</Text>
              </View>
              {selected && <Ionicons name="checkmark-circle" size={22} color={colors.primary} />}
            </Pressable>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  head: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.base, gap: space.sm, height: 56 },
  title: { ...type$.titleMd, color: colors.ink },
  scroll: { padding: space.lg, gap: space.sm },
  card: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: colors.canvas,
    borderWidth: 1, borderColor: colors.hairline, borderRadius: 14,
    padding: space.base,
  },
  cardSelected: { borderColor: colors.primary },
  cardTitle: { ...type$.titleSm, color: colors.ink, marginBottom: 4 },
  cardSub: { ...type$.bodySm, color: colors.body },
});
