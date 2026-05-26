import { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  StyleSheet,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router } from "expo-router";
import type { MeDTO } from "@fina/shared";
import { apiFetch } from "../../src/api/client";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";

export default function EditProfile() {
  const [me, setMe] = useState<MeDTO | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<MeDTO>("/me")
      .then((m) => {
        setMe(m);
        setName(m.user.name ?? "");
      })
      .catch((e) => setErr((e as { code?: string }).code ?? "load_error"));
  }, []);

  const trimmed = name.trim();
  const initialName = me?.user.name ?? "";
  const dirty = trimmed !== initialName && trimmed.length > 0;

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const next = await apiFetch<MeDTO>("/me", {
        method: "PATCH",
        body: JSON.stringify({ name: trimmed }),
      });
      setMe(next);
      router.back();
    } catch (e) {
      Alert.alert("Couldn't save", (e as { code?: string }).code ?? "Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!me) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Header onBack={() => router.back()} />
        <View style={styles.fallback}>
          {err ? (
            <Text style={styles.errText}>Couldn't load ({err})</Text>
          ) : (
            <ActivityIndicator color={colors.primary} />
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Header
        onBack={() => router.back()}
        onSave={save}
        saveEnabled={dirty && !saving}
        saving={saving}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.eyebrow}>Name</Text>
          <View style={styles.field}>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Your name"
              placeholderTextColor={colors.mutedSoft}
              style={styles.input}
              autoCapitalize="words"
              autoCorrect={false}
              maxLength={80}
              editable={!saving}
              returnKeyType="done"
              onSubmitEditing={save}
            />
          </View>

          <Text style={[styles.eyebrow, { marginTop: space.lg }]}>Email</Text>
          <View style={[styles.field, styles.fieldDisabled]}>
            <Text style={styles.readonly}>{me.user.email}</Text>
          </View>
          <Text style={styles.helper}>
            Email is the address you sign in with. Contact support to change it.
          </Text>

          <Text style={[styles.eyebrow, { marginTop: space.lg }]}>Time zone</Text>
          <View style={[styles.field, styles.fieldDisabled]}>
            <Text style={styles.readonly}>{me.user.tz}</Text>
          </View>
          <Text style={styles.helper}>
            Auto-detected from your device on each app open.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Header({
  onBack,
  onSave,
  saveEnabled,
  saving,
}: {
  onBack: () => void;
  onSave?: () => void;
  saveEnabled?: boolean;
  saving?: boolean;
}) {
  return (
    <View style={styles.head}>
      <HeaderIconButton icon="chevron-back" variant="plain" onPress={onBack} />
      <Text style={styles.title}>Edit profile</Text>
      {onSave ? (
        <Pressable
          onPress={onSave}
          disabled={!saveEnabled}
          style={({ pressed }) => [
            styles.saveBtn,
            !saveEnabled && { opacity: 0.4 },
            pressed && saveEnabled && { opacity: 0.7 },
          ]}
        >
          {saving ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text style={styles.saveBtnText}>Save</Text>
          )}
        </Pressable>
      ) : (
        <View style={{ width: 56 }} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  head: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.base,
    paddingVertical: space.sm,
    gap: space.sm,
  },
  title: { ...type$.titleMd, color: colors.ink, flex: 1 },
  saveBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    minWidth: 56,
    alignItems: "center",
    justifyContent: "center",
  },
  saveBtnText: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },
  scroll: { padding: space.lg, paddingBottom: space.xxl },
  fallback: { flex: 1, alignItems: "center", justifyContent: "center" },
  errText: { ...type$.bodyMd, color: colors.down },
  eyebrow: {
    ...type$.captionStrong,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: space.xs,
  },
  field: {
    backgroundColor: colors.surfaceSoft,
    borderRadius: 12,
    paddingHorizontal: space.base,
    paddingVertical: 12,
  },
  fieldDisabled: { opacity: 0.7 },
  input: { ...type$.bodyMd, color: colors.ink, padding: 0 },
  readonly: { ...type$.bodyMd, color: colors.body },
  helper: {
    ...type$.bodySm,
    color: colors.muted,
    marginTop: space.xs,
    paddingHorizontal: 4,
  },
});
