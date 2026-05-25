import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  Platform,
} from "react-native";
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { Ionicons } from "@expo/vector-icons";
import { colors, space, type as type$ } from "../design/tokens";

type Props = {
  visible: boolean;
  /** Currently selected year (4-digit). */
  year: number;
  /** Currently selected month (1-12). */
  month: number;
  /** How many months back from the current calendar month to offer.
   *  Defaults to 36 (three years). Future months are never shown. */
  monthsBack?: number;
  onClose: () => void;
  onSelect: (year: number, month: number) => void;
};

const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function startOfCurrentMonth(): { year: number; month: number } {
  const d = new Date();
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

function prev({ year, month }: { year: number; month: number }) {
  if (month === 1) return { year: year - 1, month: 12 };
  return { year, month: month - 1 };
}

export function MonthPickerSheet({
  visible,
  year,
  month,
  monthsBack = 36,
  onClose,
  onSelect,
}: Props) {
  const ref = useRef<BottomSheet>(null);
  const scrollRef = useRef<ScrollView>(null);
  const snapPoints = useMemo(() => ["55%"], []);

  const options = useMemo(() => {
    const out: Array<{ year: number; month: number }> = [];
    let cur = startOfCurrentMonth();
    for (let i = 0; i < monthsBack; i++) {
      out.push(cur);
      cur = prev(cur);
    }
    return out;
  }, [monthsBack]);

  // When the sheet opens, scroll so the currently selected option is
  // near the top. Each row is ~52px tall.
  useEffect(() => {
    if (!visible) return;
    const idx = options.findIndex(
      (o) => o.year === year && o.month === month,
    );
    if (idx <= 0) return;
    const ROW = 52;
    const target = Math.max(0, (idx - 1) * ROW);
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ y: target, animated: false });
    });
  }, [visible, options, year, month]);

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
          <Text style={styles.title}>Pick a month</Text>
          <View style={{ width: 50 }} />
        </View>
        <ScrollView
          ref={scrollRef}
          style={styles.list}
          {...(Platform.OS === "ios" ? { showsVerticalScrollIndicator: false } : {})}
        >
          {options.map((o) => {
            const selected = o.year === year && o.month === month;
            return (
              <Pressable
                key={`${o.year}-${o.month}`}
                onPress={() => {
                  ref.current?.close();
                  onSelect(o.year, o.month);
                }}
                style={({ pressed }) => [
                  styles.row,
                  pressed && { backgroundColor: colors.surfaceSoft },
                ]}
              >
                <Text style={[styles.rowText, selected && styles.rowTextSel]}>
                  {MONTH_LABELS[o.month - 1] ?? ""} {o.year}
                </Text>
                {selected && (
                  <Ionicons name="checkmark" size={18} color={colors.primary} />
                )}
              </Pressable>
            );
          })}
        </ScrollView>
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
  list: { flex: 1 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
  rowText: { ...type$.bodyMd, color: colors.ink },
  rowTextSel: { color: colors.primary, fontWeight: "600" },
});
