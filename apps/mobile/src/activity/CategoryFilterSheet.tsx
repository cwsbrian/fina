import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetScrollView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { Ionicons } from "@expo/vector-icons";
import type { CategoryDTO } from "@fina/shared";

import { categoryMeta } from "../categories/meta";
import { colors, space, type as type$ } from "../design/tokens";

export const UNCATEGORIZED_FILTER_ID = "__uncategorized__";

type Props = {
  visible: boolean;
  categories: CategoryDTO[];
  selectedIds: string[];
  onClose: () => void;
  onApply: (selectedIds: string[]) => void;
};

export function CategoryFilterSheet({ visible, categories, selectedIds, onClose, onApply }: Props) {
  const ref = useRef<BottomSheet>(null);
  const [draft, setDraft] = useState(() => new Set(selectedIds));
  const snapPoints = useMemo(() => ["80%"], []);
  const expenseCategories = useMemo(
    () =>
      categories
        .filter((category) => category.type === "expense" && !category.archivedAt)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [categories],
  );

  useEffect(() => {
    if (visible) setDraft(new Set(selectedIds));
  }, [selectedIds, visible]);

  const toggle = useCallback((id: string) => {
    setDraft((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
      <View style={styles.head}>
        <Pressable onPress={() => ref.current?.close()} hitSlop={8}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>Filter categories</Text>
        <Pressable
          onPress={() => {
            onApply([...draft]);
            ref.current?.close();
          }}
          hitSlop={8}
        >
          <Text style={styles.apply}>Apply</Text>
        </Pressable>
      </View>

      <BottomSheetScrollView contentContainerStyle={styles.list}>
        <FilterRow
          label="All categories"
          subtitle="Show every transaction"
          icon="apps-outline"
          selected={draft.size === 0}
          onPress={() => setDraft(new Set())}
        />
        {expenseCategories.map((category) => {
          const meta = categoryMeta(category);
          return (
            <View key={category.id}>
              <View style={styles.separator} />
              <FilterRow
                label={category.name}
                icon={meta.icon}
                iconColor={meta.fg}
                iconBackground={meta.bg}
                selected={draft.has(category.id)}
                onPress={() => toggle(category.id)}
              />
            </View>
          );
        })}
        <View style={styles.separator} />
        <FilterRow
          label="Uncategorized"
          icon="help-circle-outline"
          selected={draft.has(UNCATEGORIZED_FILTER_ID)}
          onPress={() => toggle(UNCATEGORIZED_FILTER_ID)}
        />
      </BottomSheetScrollView>
    </BottomSheet>
  );
}

function FilterRow({
  label,
  subtitle,
  icon,
  iconColor = colors.muted,
  iconBackground = colors.surfaceSoft,
  selected,
  onPress,
}: {
  label: string;
  subtitle?: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  iconColor?: string;
  iconBackground?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={[styles.glyph, { backgroundColor: iconBackground }]}>
        <Ionicons name={icon} size={17} color={iconColor} />
      </View>
      <View style={styles.rowCopy}>
        <Text style={styles.name}>{label}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      <Ionicons
        name={selected ? "checkbox" : "square-outline"}
        size={23}
        color={selected ? colors.primary : colors.mutedSoft}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  background: {
    backgroundColor: colors.canvas,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  grabber: { backgroundColor: colors.mutedSoft, width: 36, height: 4 },
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
  apply: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },
  list: { paddingHorizontal: space.lg, paddingBottom: space.xl },
  row: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: 8,
    borderRadius: 12,
  },
  rowPressed: { opacity: 0.6 },
  glyph: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  rowCopy: { flex: 1 },
  name: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  subtitle: { ...type$.bodySm, color: colors.muted, marginTop: 1 },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.hairline,
    marginLeft: 48,
  },
});
