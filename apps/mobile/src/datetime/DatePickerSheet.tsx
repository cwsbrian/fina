import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, Platform } from "react-native";
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import DateTimePicker from "@react-native-community/datetimepicker";
import { colors, space, type as type$ } from "../design/tokens";

type Props = {
  visible: boolean;
  value: Date;
  /** Latest date the user is allowed to pick. Default: today. */
  maximumDate?: Date;
  /** Sheet dismiss (Cancel / backdrop / drag-down). Parent should
   *  clear its `visible` state. */
  onClose: () => void;
  /** Fires when Done is pressed with the chosen date. The sheet
   *  dismisses itself; parent should NOT call onClose in response. */
  onConfirm: (next: Date) => void;
};

export function DatePickerSheet({
  visible,
  value,
  maximumDate,
  onClose,
  onConfirm,
}: Props) {
  const ref = useRef<BottomSheet>(null);
  const [draft, setDraft] = useState<Date>(value);

  const snapPoints = useMemo(() => ["50%"], []);

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

        <DateTimePicker
          value={draft}
          mode="date"
          display={Platform.OS === "ios" ? "spinner" : "default"}
          maximumDate={maximumDate ?? new Date()}
          onChange={(_, selected) => {
            if (selected) setDraft(selected);
          }}
          style={{ alignSelf: "stretch" }}
        />
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
});
