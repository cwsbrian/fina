import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { Ionicons } from "@expo/vector-icons";
import type { CategoryDTO } from "@fina/shared";

import { colors, space, type as type$ } from "../design/tokens";
import { DateRangeSheet } from "../datetime/DateRangeSheet";
import {
  CategoryFilterSheet,
  UNCATEGORIZED_FILTER_ID,
  type ActivityDirectionFilter,
  type ActivityFilters,
} from "./CategoryFilterSheet";

type Picker = "direction" | "date" | "categories" | null;

type Props = {
  visible: boolean;
  topInset: number;
  bottomInset: number;
  filters: ActivityFilters;
  categories: CategoryDTO[];
  onClose: () => void;
  onApply: (filters: ActivityFilters) => void;
};

const DIRECTIONS: ReadonlyArray<{
  value: ActivityDirectionFilter;
  label: string;
  description: string;
}> = [
  { value: "all", label: "All transactions", description: "Expenses and income" },
  { value: "expense", label: "Expenses", description: "Money going out" },
  { value: "income", label: "Income", description: "Money coming in" },
];

export function ActivityFilterScreen({
  visible,
  topInset,
  bottomInset,
  filters,
  categories,
  onClose,
  onApply,
}: Props) {
  const [draft, setDraft] = useState<ActivityFilters>(filters);
  const [picker, setPicker] = useState<Picker>(null);

  useEffect(() => {
    if (!visible) return;
    setDraft(filters);
    setPicker(null);
  }, [filters, visible]);

  const applyDirection = useCallback(
    (direction: ActivityDirectionFilter) => {
      setDraft((current) => {
        if (direction === "all") return { ...current, direction };
        const allowed = new Set(
          categories
            .filter((category) => category.type === direction)
            .map((category) => category.id),
        );
        return {
          ...current,
          direction,
          selectedCategoryIds: current.selectedCategoryIds.filter(
            (id) => id === UNCATEGORIZED_FILTER_ID || allowed.has(id),
          ),
        };
      });
      setPicker(null);
    },
    [categories],
  );

  return (
    <View style={[styles.safe, { paddingTop: topInset, paddingBottom: bottomInset }]}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close filters"
          onPress={onClose}
          hitSlop={8}
          style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
        >
          <Ionicons name="chevron-back" size={23} color={colors.ink} />
        </Pressable>
        <Text style={styles.title}>Filters</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => onApply(draft)}
          hitSlop={8}
          style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}
        >
          <Text style={styles.headerActionText}>Apply</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View>
          <FilterOption
            icon="swap-vertical-outline"
            label="Transaction type"
            value={directionLabel(draft.direction)}
            onPress={() => setPicker("direction")}
          />
          <View style={styles.separator} />
          <FilterOption
            icon="calendar-outline"
            label="Date"
            value={dateLabel(draft.range)}
            onPress={() => setPicker("date")}
          />
          <View style={styles.separator} />
          <FilterOption
            icon="pricetags-outline"
            label="Categories"
            value={categoryLabel(draft.selectedCategoryIds, categories)}
            onPress={() => setPicker("categories")}
          />
        </View>
        <Text style={styles.help}>Tap an item to choose its filter options.</Text>
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          accessibilityRole="button"
          onPress={() => onApply({ direction: "all", range: {}, selectedCategoryIds: [] })}
          style={({ pressed }) => [styles.resetButton, pressed && styles.resetPressed]}
        >
          <Text style={styles.resetButtonText}>Reset filters</Text>
        </Pressable>
      </View>

      <DirectionSheet
        visible={picker === "direction"}
        value={draft.direction}
        onClose={() => setPicker(null)}
        onApply={applyDirection}
      />
      <DateRangeSheet
        visible={picker === "date"}
        value={draft.range}
        onClose={() => setPicker(null)}
        onConfirm={(range) => {
          setDraft((current) => ({ ...current, range }));
          setPicker(null);
        }}
      />
      <CategoryFilterSheet
        visible={picker === "categories"}
        categories={categories}
        direction={draft.direction}
        selectedCategoryIds={draft.selectedCategoryIds}
        onClose={() => setPicker(null)}
        onApply={(selectedCategoryIds) => {
          setDraft((current) => ({ ...current, selectedCategoryIds }));
          setPicker(null);
        }}
      />
    </View>
  );
}

function DirectionSheet({
  visible,
  value,
  onClose,
  onApply,
}: {
  visible: boolean;
  value: ActivityDirectionFilter;
  onClose: () => void;
  onApply: (value: ActivityDirectionFilter) => void;
}) {
  const ref = useRef<BottomSheet>(null);
  const [draft, setDraft] = useState(value);
  const snapPoints = useMemo(() => ["48%"], []);

  useEffect(() => {
    if (visible) setDraft(value);
  }, [value, visible]);

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
      backgroundStyle={styles.sheetBackground}
      enablePanDownToClose
    >
      <BottomSheetView style={styles.directionBody}>
        <View style={styles.sheetHeader}>
          <Pressable onPress={() => ref.current?.close()} hitSlop={8}>
            <Text style={styles.sheetCancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.sheetTitle}>Transaction type</Text>
          <Pressable
            onPress={() => {
              onApply(draft);
              ref.current?.close();
            }}
            hitSlop={8}
          >
            <Text style={styles.sheetApply}>Apply</Text>
          </Pressable>
        </View>
        {DIRECTIONS.map((item) => {
          const selected = item.value === draft;
          return (
            <Pressable
              key={item.value}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => setDraft(item.value)}
              style={({ pressed }) => [styles.directionRow, pressed && styles.pressed]}
            >
              <View style={styles.optionCopy}>
                <Text style={styles.directionLabel}>{item.label}</Text>
                <Text style={styles.directionDescription}>{item.description}</Text>
              </View>
              <Ionicons
                name={selected ? "checkmark-circle" : "ellipse-outline"}
                size={23}
                color={selected ? colors.primary : colors.mutedSoft}
              />
            </Pressable>
          );
        })}
      </BottomSheetView>
    </BottomSheet>
  );
}

function directionLabel(direction: ActivityDirectionFilter): string {
  if (direction === "expense") return "Expenses";
  if (direction === "income") return "Income";
  return "All transactions";
}

function FilterOption({
  icon,
  label,
  value,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
    >
      <View style={styles.optionIcon}>
        <Ionicons name={icon} size={19} color={colors.primary} />
      </View>
      <View style={styles.optionCopy}>
        <Text style={styles.optionLabel}>{label}</Text>
        <Text style={styles.optionValue} numberOfLines={1}>
          {value}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.mutedSoft} />
    </Pressable>
  );
}

function dateLabel(range: ActivityFilters["range"]): string {
  if (range.from && range.to) return `${range.from} – ${range.to}`;
  if (range.from) return `From ${range.from}`;
  if (range.to) return `Through ${range.to}`;
  return "All time";
}

function categoryLabel(selectedIds: string[], categories: CategoryDTO[]): string {
  if (selectedIds.length === 0) return "All categories";
  if (selectedIds.length > 1) return `${selectedIds.length} selected`;
  const id = selectedIds[0];
  if (id === UNCATEGORIZED_FILTER_ID) return "Uncategorized";
  return categories.find((category) => category.id === id)?.name ?? "1 selected";
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  header: {
    height: 58,
    paddingHorizontal: space.base,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.hairline,
  },
  headerButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { ...type$.titleMd, color: colors.ink },
  headerAction: { minWidth: 52, minHeight: 40, alignItems: "flex-end", justifyContent: "center" },
  headerActionText: { ...type$.bodyMd, color: colors.primary, fontWeight: "700" },
  content: { padding: space.lg, paddingBottom: 40 },
  option: { minHeight: 76, flexDirection: "row", alignItems: "center", gap: 12 },
  optionPressed: { opacity: 0.6 },
  optionIcon: {
    width: 40,
    height: 40,
    borderRadius: 13,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  optionCopy: { flex: 1 },
  optionLabel: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  optionValue: { ...type$.bodySm, color: colors.muted, marginTop: 3 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.hairline, marginLeft: 52 },
  help: { ...type$.bodySm, color: colors.muted, marginTop: space.base, textAlign: "center" },
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.base,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.hairline,
  },
  resetButton: {
    height: 52,
    borderRadius: 999,
    backgroundColor: colors.surfaceStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  resetPressed: { opacity: 0.72 },
  resetButtonText: { ...type$.button, color: colors.body },
  pressed: { opacity: 0.6 },
  grabber: { backgroundColor: colors.mutedSoft, width: 36, height: 4 },
  sheetBackground: {
    backgroundColor: colors.canvas,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  directionBody: { flex: 1 },
  sheetHeader: {
    height: 50,
    paddingHorizontal: space.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.hairline,
  },
  sheetCancel: { ...type$.bodyMd, color: colors.body },
  sheetTitle: { ...type$.titleSm, color: colors.ink },
  sheetApply: { ...type$.bodyMd, color: colors.primary, fontWeight: "700" },
  directionRow: {
    minHeight: 66,
    paddingHorizontal: space.lg,
    flexDirection: "row",
    alignItems: "center",
  },
  directionLabel: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  directionDescription: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
});
