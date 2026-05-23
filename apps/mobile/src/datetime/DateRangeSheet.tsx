import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, Platform } from "react-native";
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import DateTimePicker from "@react-native-community/datetimepicker";
import { colors, space, type as type$ } from "../design/tokens";

export type DateRange = {
  /** YYYY-MM-DD inclusive lower bound. Undefined → no lower bound. */
  from?: string;
  /** YYYY-MM-DD inclusive upper bound. Undefined → no upper bound. */
  to?: string;
};

type Props = {
  visible: boolean;
  value: DateRange;
  onClose: () => void;
  /** Fired on Apply with the final range. Empty object = no filter. */
  onConfirm: (next: DateRange) => void;
};

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}
function startOfYear(d: Date): Date {
  return new Date(d.getFullYear(), 0, 1);
}

function presetRange(kind: PresetKind): DateRange {
  const now = new Date();
  if (kind === "all") return {};
  if (kind === "this_month") {
    return { from: ymd(startOfMonth(now)), to: ymd(endOfMonth(now)) };
  }
  if (kind === "last_month") {
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { from: ymd(startOfMonth(prev)), to: ymd(endOfMonth(prev)) };
  }
  if (kind === "last_30") {
    const start = new Date(now);
    start.setDate(start.getDate() - 29);
    return { from: ymd(start), to: ymd(now) };
  }
  if (kind === "ytd") {
    return { from: ymd(startOfYear(now)), to: ymd(now) };
  }
  return {};
}

type PresetKind =
  | "all"
  | "this_month"
  | "last_month"
  | "last_30"
  | "ytd";

const PRESETS: ReadonlyArray<{ kind: PresetKind; label: string }> = [
  { kind: "all", label: "All time" },
  { kind: "this_month", label: "This month" },
  { kind: "last_month", label: "Last month" },
  { kind: "last_30", label: "Last 30 days" },
  { kind: "ytd", label: "Year to date" },
];

function detectPreset(r: DateRange): PresetKind | null {
  if (!r.from && !r.to) return "all";
  for (const p of PRESETS) {
    if (p.kind === "all") continue;
    const candidate = presetRange(p.kind);
    if (candidate.from === r.from && candidate.to === r.to) return p.kind;
  }
  return null; // custom
}

export function DateRangeSheet({
  visible,
  value,
  onClose,
  onConfirm,
}: Props) {
  const ref = useRef<BottomSheet>(null);
  const [draft, setDraft] = useState<DateRange>(value);
  const [picking, setPicking] = useState<"from" | "to" | null>(null);

  const snapPoints = useMemo(() => ["80%"], []);

  useEffect(() => {
    if (visible) {
      setDraft(value);
      setPicking(null);
    }
  }, [visible, value]);

  const activePreset = detectPreset(draft);

  const setFrom = useCallback((d: Date) => {
    setDraft((cur) => ({ ...cur, from: ymd(d) }));
  }, []);
  const setTo = useCallback((d: Date) => {
    setDraft((cur) => ({ ...cur, to: ymd(d) }));
  }, []);

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
      handleIndicatorStyle={styles.grabber}
      backgroundStyle={styles.background}
      enablePanDownToClose
    >
      <BottomSheetView style={styles.body}>
        <View style={styles.head}>
          <Pressable onPress={() => ref.current?.close()} hitSlop={8}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>Date range</Text>
          <Pressable
            onPress={() => {
              ref.current?.close();
              onConfirm(draft);
            }}
            hitSlop={8}
          >
            <Text style={styles.done}>Apply</Text>
          </Pressable>
        </View>

        <Text style={styles.label}>Quick</Text>
        <View style={styles.chipWrap}>
          {PRESETS.map((p) => {
            const isSel = activePreset === p.kind;
            return (
              <Pressable
                key={p.kind}
                onPress={() => setDraft(presetRange(p.kind))}
                style={[styles.chip, isSel && styles.chipActive]}
              >
                <Text
                  style={[
                    styles.chipText,
                    isSel && { color: colors.onPrimary },
                  ]}
                >
                  {p.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={[styles.label, { marginTop: space.lg }]}>Custom</Text>
        <View style={styles.customRow}>
          <Pressable
            onPress={() => setPicking(picking === "from" ? null : "from")}
            style={[styles.rangeBtn, picking === "from" && styles.rangeBtnActive]}
          >
            <Text style={styles.rangeLabel}>From</Text>
            <Text
              style={[
                styles.rangeValue,
                !draft.from && { color: colors.mutedSoft },
              ]}
            >
              {draft.from ?? "Any"}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setPicking(picking === "to" ? null : "to")}
            style={[styles.rangeBtn, picking === "to" && styles.rangeBtnActive]}
          >
            <Text style={styles.rangeLabel}>To</Text>
            <Text
              style={[
                styles.rangeValue,
                !draft.to && { color: colors.mutedSoft },
              ]}
            >
              {draft.to ?? "Any"}
            </Text>
          </Pressable>
        </View>

        {picking && (
          <DateTimePicker
            value={
              picking === "from"
                ? draft.from
                  ? new Date(draft.from + "T12:00:00Z")
                  : new Date()
                : draft.to
                  ? new Date(draft.to + "T12:00:00Z")
                  : new Date()
            }
            mode="date"
            display={Platform.OS === "ios" ? "spinner" : "default"}
            maximumDate={new Date()}
            onChange={(_, sel) => {
              if (!sel) return;
              if (picking === "from") setFrom(sel);
              else setTo(sel);
            }}
            style={{ alignSelf: "stretch" }}
          />
        )}
      </BottomSheetView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  background: {
    backgroundColor: colors.canvas,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  grabber: { backgroundColor: colors.mutedSoft, width: 36, height: 4 },
  body: { flex: 1, paddingHorizontal: space.lg },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: space.xs,
    paddingBottom: space.sm,
  },
  title: { ...type$.titleSm, color: colors.ink, fontWeight: "600" },
  cancel: { ...type$.bodyMd, color: colors.muted },
  done: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },
  label: {
    ...type$.bodySm,
    color: colors.muted,
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginTop: space.sm,
    marginBottom: space.sm,
  },
  chipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    paddingHorizontal: space.base,
    paddingVertical: 10,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 999,
  },
  chipActive: { backgroundColor: colors.primary },
  chipText: { ...type$.bodySm, color: colors.ink, fontWeight: "600" },
  customRow: {
    flexDirection: "row",
    gap: 10,
  },
  rangeBtn: {
    flex: 1,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 12,
    paddingHorizontal: space.base,
    paddingVertical: 12,
    borderWidth: 2,
    borderColor: "transparent",
  },
  rangeBtnActive: { borderColor: colors.primary },
  rangeLabel: {
    ...type$.bodySm,
    color: colors.muted,
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  rangeValue: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
});
