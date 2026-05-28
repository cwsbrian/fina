import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Platform,
  useWindowDimensions,
} from "react-native";
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import DateTimePicker, {
  type DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import { colors, space, type as type$ } from "../design/tokens";

type Props = {
  visible: boolean;
  value: Date;
  /** Picker mode. Defaults to "date" (just the day). Use "datetime"
   *  for date + time-of-day. */
  mode?: "date" | "datetime" | "time";
  /** Latest moment the user is allowed to pick. Default: now. */
  maximumDate?: Date;
  /** Sheet dismiss (Cancel / backdrop / drag-down). Parent should
   *  clear its `visible` state. */
  onClose: () => void;
  /** Fires when Done is pressed with the chosen value. The sheet
   *  dismisses itself; parent should NOT call onClose in response. */
  onConfirm: (next: Date) => void;
};

export function DatePickerSheet(props: Props) {
  // On Android the native picker is a modal dialog that opens the moment it
  // mounts and emits a single terminal set/dismissed event. The iOS path
  // keeps it permanently mounted inside a bottom sheet, which on Android
  // would auto-open the dialog at the root layout and re-open it after every
  // Cancel. So Android gets a dedicated dialog-only path; iOS keeps the sheet.
  if (Platform.OS === "android") {
    return <AndroidDatePicker {...props} />;
  }
  return <IosDatePickerSheet {...props} />;
}

function AndroidDatePicker({
  visible,
  value,
  mode = "date",
  maximumDate,
  onClose,
  onConfirm,
}: Props) {
  if (!visible) return null;
  return (
    <DateTimePicker
      value={value}
      mode={mode}
      display="default"
      maximumDate={maximumDate ?? new Date()}
      onChange={(event: DateTimePickerEvent, selected?: Date) => {
        if (event.type === "set" && selected) onConfirm(selected);
        else onClose();
      }}
    />
  );
}

function IosDatePickerSheet({
  visible,
  value,
  mode = "date",
  maximumDate,
  onClose,
  onConfirm,
}: Props) {
  const ref = useRef<BottomSheet>(null);
  const [draft, setDraft] = useState<Date>(value);
  const { width: screenW } = useWindowDimensions();

  // The iOS wheel picker is ~216px tall; header is ~50; safe-area bottom
  // varies. ~38% fits cleanly on most phones without leaving dead space
  // below the wheels.
  const snapPoints = useMemo(() => ["38%"], []);

  // Reset the draft whenever the sheet opens — so a Cancel after
  // scrolling doesn't permanently shift the displayed initial date.
  useEffect(() => {
    if (visible) setDraft(value);
  }, [visible, value]);

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
          <Pressable
            onPress={() => ref.current?.close()}
            hitSlop={8}
          >
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>Date</Text>
          <Pressable
            onPress={() => {
              ref.current?.close();
              onConfirm(draft);
            }}
            hitSlop={8}
          >
            <Text style={styles.done}>Done</Text>
          </Pressable>
        </View>

        <View style={styles.pickerWrap}>
          <DateTimePicker
            value={draft}
            mode={mode}
            display="spinner"
            maximumDate={maximumDate ?? new Date()}
            onChange={(_, selected) => {
              if (selected) setDraft(selected);
            }}
            style={{ width: screenW, height: 216 }}
          />
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
  pickerWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
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
});
