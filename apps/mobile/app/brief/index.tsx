import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Switch,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { useMemo, useRef } from "react";
import type { MeDTO as Me } from "@fina/shared";
import { apiFetch } from "../../src/api/client";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";

function formatTime(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const date = new Date();
  date.setHours(h, m, 0, 0);
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toHHmm(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function hhmmToDate(hhmm: string): Date {
  const [hStr, mStr] = hhmm.split(":");
  const d = new Date();
  d.setHours(Number(hStr) || 8, Number(mStr) || 0, 0, 0);
  return d;
}

export default function MorningBriefSettings() {
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const m = await apiFetch<Me>("/me");
      setMe(m);
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      setSaving(true);
      try {
        const m = await apiFetch<Me>("/me", {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        setMe(m);
      } catch (e) {
        Alert.alert(
          "Couldn't save",
          (e as { code?: string }).code ?? "Try again.",
        );
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const onTimeConfirm = (next: Date) => {
    setTimeOpen(false);
    patch({ morningTime: toHHmm(next) });
  };

  if (!me) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Header />
        <View style={styles.fallback}>
          {err ? (
            <>
              <Text style={styles.errTitle}>Couldn't load</Text>
              <Text style={styles.errBody}>{err}</Text>
              <Pressable style={styles.cta} onPress={load}>
                <Text style={styles.ctaText}>Try again</Text>
              </Pressable>
            </>
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
      <Header />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.lead}>
          Fina drops a short summary every morning — categorize anything new,
          flag scheduled items, nudge you on budget. Set when to receive it
          and pause anytime.
        </Text>

        <Text style={styles.groupLabel}>Delivery</Text>
        <View style={styles.group}>
          <Pressable
            style={({ pressed }) => [
              styles.row,
              pressed && { backgroundColor: colors.surfaceSoft },
            ]}
            onPress={() => setTimeOpen(true)}
            disabled={saving}
          >
            <View style={styles.rowGlyph}>
              <Ionicons name="time-outline" size={18} color={colors.muted} />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Brief time</Text>
              <Text style={styles.rowSub}>
                Every morning at {formatTime(me.user.morningTime ?? "08:00")}
              </Text>
            </View>
            <Text style={styles.rowDetail}>
              {formatTime(me.user.morningTime ?? "08:00")}
            </Text>
            <Ionicons
              name="chevron-forward"
              size={14}
              color={colors.mutedSoft}
              style={{ marginLeft: 4 }}
            />
          </Pressable>

          <View style={[styles.row, styles.rowBorder]}>
            <View style={styles.rowGlyph}>
              <Ionicons name="pause-outline" size={18} color={colors.muted} />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Pause briefings</Text>
              <Text style={styles.rowSub}>
                {me.user.pauseEnabled
                  ? "Paused — Fina won't send a brief until you turn this off."
                  : "Skip the morning brief without losing your time setting."}
              </Text>
            </View>
            <Switch
              value={me.user.pauseEnabled}
              onValueChange={(v) => patch({ pauseEnabled: v })}
              disabled={saving}
              trackColor={{ true: colors.primary, false: colors.surfaceStrong }}
            />
          </View>
        </View>

        <Text style={styles.helper}>
          Briefs use the timezone on your account ({me.user.tz}). Change it
          from More → Profile if you've moved.
        </Text>
      </ScrollView>

      <TimePickerSheet
        visible={timeOpen}
        initial={hhmmToDate(me.user.morningTime ?? "08:00")}
        onClose={() => setTimeOpen(false)}
        onConfirm={onTimeConfirm}
      />
    </SafeAreaView>
  );
}

function Header() {
  return (
    <View style={styles.nav}>
      <HeaderIconButton
        icon="chevron-back"
        accessibilityLabel="Back"
        onPress={() => router.back()}
        variant="plain"
      />
      <Text style={styles.navTitle}>Morning brief</Text>
      <View style={{ width: 34 }} />
    </View>
  );
}

function TimePickerSheet({
  visible,
  initial,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  initial: Date;
  onClose: () => void;
  onConfirm: (d: Date) => void;
}) {
  const ref = useRef<BottomSheet>(null);
  const snapPoints = useMemo(() => ["38%"], []);
  const [draft, setDraft] = useState<Date>(initial);

  useEffect(() => {
    if (visible) setDraft(initial);
  }, [visible, initial]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={0.35}
        pressBehavior="close"
      />
    ),
    [],
  );

  return (
    <BottomSheet
      ref={ref}
      snapPoints={snapPoints}
      enableDynamicSizing={false}
      index={visible ? 0 : -1}
      backdropComponent={renderBackdrop}
      onClose={onClose}
      handleIndicatorStyle={sheetStyles.grabber}
      backgroundStyle={sheetStyles.background}
      enablePanDownToClose
    >
      <BottomSheetView style={sheetStyles.body}>
        <View style={sheetStyles.head}>
          <Pressable onPress={() => ref.current?.close()} hitSlop={8}>
            <Text style={sheetStyles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={sheetStyles.title}>Brief time</Text>
          <Pressable
            onPress={() => {
              ref.current?.close();
              onConfirm(draft);
            }}
            hitSlop={8}
          >
            <Text style={sheetStyles.done}>Done</Text>
          </Pressable>
        </View>
        <View style={sheetStyles.pickerWrap}>
          <DateTimePicker
            value={draft}
            mode="time"
            display="spinner"
            minuteInterval={5}
            onChange={(_, selected) => {
              if (selected) setDraft(selected);
            }}
            style={{ width: "100%", height: 216 }}
          />
        </View>
      </BottomSheetView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  nav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.base,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  navTitle: { ...type$.titleSm, color: colors.ink, fontWeight: "600" },

  scroll: { padding: space.lg, paddingBottom: space.xl },
  fallback: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
  errTitle: { ...type$.titleMd, color: colors.down, marginBottom: 4 },
  errBody: { ...type$.bodyMd, color: colors.body, marginBottom: space.base },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm + 2,
    borderRadius: 999,
  },
  ctaText: { ...type$.bodyMd, color: colors.onPrimary, fontWeight: "600" },

  lead: {
    ...type$.bodyMd,
    color: colors.body,
    marginBottom: space.lg,
  },
  groupLabel: {
    ...type$.captionStrong,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: space.sm,
  },
  group: {
    backgroundColor: colors.canvas,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.hairlineSoft,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.base,
    paddingHorizontal: space.base,
  },
  rowBorder: {
    borderTopWidth: 1,
    borderTopColor: colors.hairlineSoft,
  },
  rowGlyph: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  rowSub: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  rowDetail: { ...type$.bodyMd, color: colors.body },

  helper: {
    ...type$.bodySm,
    color: colors.muted,
    marginTop: space.lg,
    textAlign: "center",
    paddingHorizontal: space.lg,
  },
});

const sheetStyles = StyleSheet.create({
  background: {
    backgroundColor: colors.canvas,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  grabber: { backgroundColor: colors.mutedSoft, width: 36, height: 4 },
  body: { flex: 1 },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingTop: space.xs,
    paddingBottom: space.sm,
  },
  title: { ...type$.titleSm, color: colors.ink, fontWeight: "600" },
  cancel: { ...type$.bodyMd, color: colors.muted },
  done: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },
  pickerWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
