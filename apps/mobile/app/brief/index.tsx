import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { MeDTO as Me } from "@fina/shared";
import { apiFetch } from "../../src/api/client";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
import { DatePickerSheet } from "../../src/datetime/DatePickerSheet";

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
function splitTime(hhmm: string): { h12: string; mm: string; ampm: string } {
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr) || 8;
  const m = Number(mStr) || 0;
  const ampm = h >= 12 ? "PM" : "AM";
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return { h12: String(h12), mm: pad2(m), ampm };
}
function formatSnooze(iso: string | null): string {
  if (!iso) return "Off";
  const d = new Date(iso);
  const now = new Date();
  if (d.getTime() <= now.getTime()) return "Off";
  return `Until ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

type SnoozeOption = { key: string; label: string; daysAhead: number | null };
const SNOOZE_OPTIONS: SnoozeOption[] = [
  { key: "off", label: "Off — keep sending", daysAhead: null },
  { key: "1d", label: "1 day", daysAhead: 1 },
  { key: "3d", label: "3 days", daysAhead: 3 },
  { key: "1w", label: "1 week", daysAhead: 7 },
  { key: "1mo", label: "1 month", daysAhead: 30 },
];

function daysAheadIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateToYmd(d: Date): string {
  // Local-time YYYY-MM-DD — matches the calendar day the user picked,
  // not a UTC-shifted day.
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  return `${y}-${m}-${dd}`;
}

export default function MorningBriefSettings() {
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [customDateOpen, setCustomDateOpen] = useState(false);

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

  const patch = useCallback(async (body: Record<string, unknown>) => {
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
  }, []);

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

  const morningTime = me.user.morningTime ?? "08:00";
  const t = splitTime(morningTime);
  const enabled = !me.user.pauseEnabled;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Header />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.hero}>
          <View style={styles.heroGlyph}>
            <Ionicons name="sunny-outline" size={26} color={colors.primary} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.heroTitle}>Daily morning brief</Text>
            <Text style={styles.heroSub}>
              Fina sends one push each morning with yesterday's activity and
              what's coming.
            </Text>
          </View>
        </View>

        <Text style={styles.groupLabel}>Delivery</Text>
        <View style={styles.group}>
          <View style={styles.row}>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Get the brief</Text>
              <Text style={styles.rowSub}>Push on days with new activity</Text>
            </View>
            <Switch
              value={enabled}
              onValueChange={(v) => patch({ pauseEnabled: !v })}
              disabled={saving}
              trackColor={{ true: colors.primary, false: colors.surfaceStrong }}
            />
          </View>

          <Pressable
            style={({ pressed }) => [
              styles.row,
              styles.rowBorder,
              pressed && { backgroundColor: colors.surfaceSoft },
            ]}
            onPress={() => setTimeOpen(true)}
            disabled={saving || !enabled}
          >
            <View style={styles.rowBody}>
              <Text style={[styles.rowTitle, !enabled && { color: colors.muted }]}>
                Delivery time
              </Text>
              <Text style={styles.rowSub}>Tap to change</Text>
            </View>
            <Text style={[styles.rowDetail, !enabled && { color: colors.mutedSoft }]}>
              {t.h12}:{t.mm} {t.ampm}
            </Text>
            <Ionicons
              name="chevron-forward"
              size={14}
              color={colors.mutedSoft}
              style={{ marginLeft: 4 }}
            />
          </Pressable>

          <View style={[styles.row, styles.rowBorder]}>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Time zone</Text>
              <Text style={styles.rowSub}>Profile setting</Text>
            </View>
            <Text style={styles.rowDetail}>{me.user.tz}</Text>
          </View>
        </View>

        {/* Big time hero — design's centerpiece. */}
        <View style={styles.timeHero}>
          <Text style={styles.timeNum}>{t.h12}</Text>
          <Text style={styles.timeColon}>:</Text>
          <Text style={styles.timeNum}>{t.mm}</Text>
          <Text style={styles.timeAmpm}>{t.ampm}</Text>
        </View>

        <Text style={styles.groupLabel}>Pause</Text>
        <View style={styles.group}>
          <Pressable
            style={({ pressed }) => [
              styles.row,
              pressed && { backgroundColor: colors.surfaceSoft },
            ]}
            onPress={() => setPauseOpen(true)}
            disabled={saving}
          >
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Pause briefs</Text>
              <Text style={styles.rowSub}>Useful for vacations</Text>
            </View>
            <Text style={styles.rowDetail}>{formatSnooze(me.user.snoozeUntil)}</Text>
            <Ionicons
              name="chevron-forward"
              size={14}
              color={colors.mutedSoft}
              style={{ marginLeft: 4 }}
            />
          </Pressable>
        </View>

      </ScrollView>

      <TimePickerSheet
        visible={timeOpen}
        initial={hhmmToDate(morningTime)}
        onClose={() => setTimeOpen(false)}
        onConfirm={(d) => {
          setTimeOpen(false);
          patch({ morningTime: toHHmm(d) });
        }}
      />
      <PauseSheet
        visible={pauseOpen}
        snoozeUntil={me.user.snoozeUntil}
        onClose={() => setPauseOpen(false)}
        onSelect={(daysAhead) => {
          setPauseOpen(false);
          patch({
            snoozeUntil: daysAhead === null ? null : daysAheadIso(daysAhead),
          });
        }}
        onPickCustom={() => {
          setPauseOpen(false);
          // Defer so the pause sheet fully closes before the date sheet
          // opens — overlapping backdrops on @gorhom/bottom-sheet get
          // stuck otherwise.
          setTimeout(() => setCustomDateOpen(true), 250);
        }}
      />
      <DatePickerSheet
        visible={customDateOpen}
        value={
          me.user.snoozeUntil
            ? new Date(me.user.snoozeUntil)
            : new Date(Date.now() + 7 * 86_400_000)
        }
        mode="date"
        maximumDate={new Date(Date.now() + 365 * 86_400_000)}
        onClose={() => setCustomDateOpen(false)}
        onConfirm={(d) => {
          setCustomDateOpen(false);
          patch({ snoozeUntil: dateToYmd(d) });
        }}
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

function PauseSheet({
  visible,
  snoozeUntil,
  onClose,
  onSelect,
  onPickCustom,
}: {
  visible: boolean;
  snoozeUntil: string | null;
  onClose: () => void;
  onSelect: (daysAhead: number | null) => void;
  onPickCustom: () => void;
}) {
  const ref = useRef<BottomSheet>(null);
  const snapPoints = useMemo(() => ["48%"], []);
  const isActive = !!snoozeUntil && new Date(snoozeUntil).getTime() > Date.now();

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
          <Text style={sheetStyles.title}>Pause briefs</Text>
          <View style={{ width: 50 }} />
        </View>
        <View style={sheetStyles.pauseList}>
          {SNOOZE_OPTIONS.map((opt) => {
            const isOff = opt.daysAhead === null;
            const isSelected = isOff ? !isActive : false;
            return (
              <Pressable
                key={opt.key}
                onPress={() => {
                  ref.current?.close();
                  onSelect(opt.daysAhead);
                }}
                style={({ pressed }) => [
                  sheetStyles.pauseRow,
                  pressed && { backgroundColor: colors.surfaceSoft },
                ]}
              >
                <Text style={sheetStyles.pauseRowText}>{opt.label}</Text>
                {isSelected && (
                  <Ionicons name="checkmark" size={18} color={colors.primary} />
                )}
              </Pressable>
            );
          })}
          <Pressable
            onPress={() => {
              ref.current?.close();
              onPickCustom();
            }}
            style={({ pressed }) => [
              sheetStyles.pauseRow,
              pressed && { backgroundColor: colors.surfaceSoft },
            ]}
          >
            <Text style={sheetStyles.pauseRowText}>Pick a date…</Text>
            <Ionicons
              name="chevron-forward"
              size={16}
              color={colors.mutedSoft}
            />
          </Pressable>
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

  hero: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.base,
    backgroundColor: "rgba(62, 179, 139, 0.10)",
    borderRadius: 16,
    padding: space.base,
    marginBottom: space.lg,
  },
  heroGlyph: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: "rgba(62, 179, 139, 0.16)",
    alignItems: "center",
    justifyContent: "center",
  },
  heroTitle: { ...type$.titleSm, color: colors.ink, fontWeight: "600" },
  heroSub: { ...type$.bodySm, color: colors.body, marginTop: 2 },

  groupLabel: {
    ...type$.captionStrong,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: space.sm,
    marginTop: space.base,
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
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  rowSub: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  rowDetail: { ...type$.bodyMd, color: colors.body },

  timeHero: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "center",
    gap: 4,
    marginTop: space.lg,
  },
  timeNum: {
    fontSize: 56,
    fontWeight: "300",
    color: colors.ink,
    letterSpacing: -2,
    fontVariant: ["tabular-nums"],
  },
  timeColon: {
    fontSize: 44,
    fontWeight: "300",
    color: colors.mutedSoft,
    marginHorizontal: 2,
  },
  timeAmpm: {
    fontSize: 18,
    fontWeight: "600",
    color: colors.muted,
    marginLeft: 8,
    letterSpacing: 1,
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
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  title: { ...type$.titleSm, color: colors.ink, fontWeight: "600" },
  cancel: { ...type$.bodyMd, color: colors.muted },
  done: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },
  pickerWrap: { flex: 1, alignItems: "center", justifyContent: "center" },

  pauseList: { flex: 1, paddingVertical: 4 },
  pauseRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
  pauseRowText: { ...type$.bodyMd, color: colors.ink },
});
