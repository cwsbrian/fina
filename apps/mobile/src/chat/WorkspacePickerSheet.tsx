import { useCallback, useMemo, useRef } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetFlatList,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { Ionicons } from "@expo/vector-icons";
import { colors, space, type as type$ } from "../design/tokens";

export type WorkspaceOption = { id: string; name: string };

type Props = {
  visible: boolean;
  workspaces: WorkspaceOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
};

/** Bottom sheet picker shown when a fresh chat thread (workspaceId still
 *  null) lets the user choose which workspace the conversation will
 *  bind to. Mounted from ThreadView; hidden by default. Only opened
 *  when the user actually has more than one workspace — the inline
 *  chip that triggers it is itself hidden in the single-workspace case. */
export function WorkspacePickerSheet({
  visible,
  workspaces,
  selectedId,
  onSelect,
  onClose,
}: Props) {
  const ref = useRef<BottomSheet>(null);
  const snapPoints = useMemo(() => ["50%"], []);

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
      <View style={styles.header}>
        <Text style={styles.title}>Send to workspace</Text>
        <Text style={styles.subtitle}>
          Pick which workspace this conversation belongs to.
        </Text>
      </View>
      <BottomSheetFlatList
        data={workspaces}
        keyExtractor={(w) => w.id}
        renderItem={({ item }) => {
          const selected = item.id === selectedId;
          return (
            <Pressable
              style={({ pressed }) => [
                styles.row,
                pressed && { backgroundColor: colors.surfaceSoft },
              ]}
              onPress={() => {
                onSelect(item.id);
                onClose();
              }}
            >
              <Text style={styles.rowName}>{item.name}</Text>
              {selected && (
                <Ionicons name="checkmark" size={20} color={colors.primary} />
              )}
            </Pressable>
          );
        }}
        contentContainerStyle={{ paddingBottom: space.xl }}
      />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  grabber: { backgroundColor: colors.hairline, width: 36, height: 4 },
  background: { backgroundColor: colors.canvas },
  header: {
    paddingHorizontal: space.lg,
    paddingTop: 8,
    paddingBottom: space.base,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  title: { ...type$.titleSm, color: colors.ink },
  subtitle: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingVertical: space.base,
  },
  rowName: { ...type$.bodyMd, color: colors.ink, fontWeight: "500" },
});
