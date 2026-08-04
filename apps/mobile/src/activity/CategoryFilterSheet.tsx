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
import type { DateRange } from "../datetime/DateRangeSheet";

export const UNCATEGORIZED_FILTER_ID = "__uncategorized__";

export type ActivityDirectionFilter = "all" | "expense" | "income";

export type ActivityFilters = {
  direction: ActivityDirectionFilter;
  range: DateRange;
  selectedCategoryIds: string[];
};

type Props = {
  visible: boolean;
  categories: CategoryDTO[];
  direction: ActivityDirectionFilter;
  selectedCategoryIds: string[];
  onClose: () => void;
  onApply: (selectedCategoryIds: string[]) => void;
};

export function CategoryFilterSheet({
  visible,
  categories,
  direction,
  selectedCategoryIds,
  onClose,
  onApply,
}: Props) {
  const ref = useRef<BottomSheet>(null);
  const [draft, setDraft] = useState(() => new Set(selectedCategoryIds));
  const snapPoints = useMemo(() => ["82%"], []);

  const activeCategories = useMemo(
    () =>
      categories
        .filter(
          (category) =>
            !category.archivedAt && (direction === "all" || category.type === direction),
        )
        .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)),
    [categories, direction],
  );

  useEffect(() => {
    if (visible) setDraft(new Set(selectedCategoryIds));
  }, [selectedCategoryIds, visible]);

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
        <Text style={styles.title}>Categories</Text>
        <Pressable
          onPress={() => {
            onApply([...draft]);
            ref.current?.close();
          }}
          hitSlop={8}
        >
          <Text style={styles.apply}>Done</Text>
        </Pressable>
      </View>

      <BottomSheetScrollView contentContainerStyle={styles.list}>
        <FilterRow
          label="All categories"
          subtitle={
            direction === "all" ? "Show every category" : `Show all ${direction} categories`
          }
          icon="apps-outline"
          selected={draft.size === 0}
          onPress={() => setDraft(new Set())}
        />
        {activeCategories.map((category) => {
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
  icon: keyof typeof Ionicons.glyphMap;
  iconColor?: string;
  iconBackground?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={[styles.icon, { backgroundColor: iconBackground }]}>
        <Ionicons name={icon} size={18} color={iconColor} />
      </View>
      <View style={styles.rowCopy}>
        <Text style={styles.rowLabel}>{label}</Text>
        {subtitle ? <Text style={styles.rowSubtitle}>{subtitle}</Text> : null}
      </View>
      <Ionicons
        name={selected ? "checkmark-circle" : "ellipse-outline"}
        size={22}
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
    height: 52,
    paddingHorizontal: space.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.hairline,
  },
  cancel: { ...type$.bodyMd, color: colors.body },
  title: { ...type$.titleSm, color: colors.ink },
  apply: { ...type$.bodyMd, color: colors.primary, fontWeight: "700" },
  list: { paddingHorizontal: space.lg, paddingBottom: 48 },
  row: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
  },
  rowPressed: { opacity: 0.65 },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  rowCopy: { flex: 1 },
  rowLabel: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  rowSubtitle: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.hairline, marginLeft: 48 },
});
