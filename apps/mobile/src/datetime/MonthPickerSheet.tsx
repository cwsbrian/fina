import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  useWindowDimensions,
} from "react-native";
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { Picker } from "@react-native-picker/picker";
import { colors, space, type as type$ } from "../design/tokens";

type Props = {
  visible: boolean;
  /** Currently selected year (4-digit). */
  year: number;
  /** Currently selected month (1-12). */
  month: number;
  /** Don't allow selections beyond `latest`. Defaults to today. */
  latest?: Date;
  /** Earliest year shown in the year wheel. Defaults to current year - 5. */
  earliestYear?: number;
  onClose: () => void;
  onConfirm: (year: number, month: number) => void;
};

const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function MonthPickerSheet({
  visible,
  year,
  month,
  latest,
  earliestYear,
  onClose,
  onConfirm,
}: Props) {
  const ref = useRef<BottomSheet>(null);
  const snapPoints = useMemo(() => ["44%"], []);
  const { width } = useWindowDimensions();

  const cap = latest ?? new Date();
  const capYear = cap.getFullYear();
  const capMonth = cap.getMonth() + 1;
  const startYear = earliestYear ?? capYear - 5;

  const yearOptions = useMemo(() => {
    const out: number[] = [];
    for (let y = capYear; y >= startYear; y--) out.push(y);
    return out;
  }, [capYear, startYear]);

  const [draftYear, setDraftYear] = useState(year);
  const [draftMonth, setDraftMonth] = useState(month);

  // Reset draft when the sheet opens so a Cancel after spinning doesn't
  // leak state into the next open.
  useEffect(() => {
    if (visible) {
      setDraftYear(year);
      setDraftMonth(month);
    }
  }, [visible, year, month]);

  // If the user spun the year wheel up to the cap year, clamp the month
  // wheel so they can't land on a future month.
  useEffect(() => {
    if (draftYear === capYear && draftMonth > capMonth) {
      setDraftMonth(capMonth);
    }
  }, [draftYear, draftMonth, capYear, capMonth]);

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
          <Pressable
            onPress={() => {
              ref.current?.close();
              onConfirm(draftYear, draftMonth);
            }}
            hitSlop={8}
          >
            <Text style={styles.done}>Done</Text>
          </Pressable>
        </View>

        <View style={styles.wheels}>
          <Picker
            selectedValue={draftMonth}
            onValueChange={(v) => setDraftMonth(Number(v))}
            style={[styles.picker, { width: width / 2 }]}
            itemStyle={styles.pickerItem}
          >
            {MONTH_LABELS.map((label, idx) => {
              const m = idx + 1;
              const disabled = draftYear === capYear && m > capMonth;
              return (
                <Picker.Item
                  key={m}
                  label={label}
                  value={m}
                  color={disabled ? colors.mutedSoft : colors.ink}
                />
              );
            })}
          </Picker>
          <Picker
            selectedValue={draftYear}
            onValueChange={(v) => setDraftYear(Number(v))}
            style={[styles.picker, { width: width / 2 }]}
            itemStyle={styles.pickerItem}
          >
            {yearOptions.map((y) => (
              <Picker.Item key={y} label={String(y)} value={y} />
            ))}
          </Picker>
        </View>
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
  },
  title: { ...type$.titleSm, color: colors.ink, fontWeight: "600" },
  cancel: { ...type$.bodyMd, color: colors.muted },
  done: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },
  wheels: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  picker: { height: 216 },
  pickerItem: { fontSize: 22, color: colors.ink },
});
