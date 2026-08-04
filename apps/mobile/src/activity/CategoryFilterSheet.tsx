import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetScrollView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
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

type Props = ActivityFilters & {
  visible: boolean;
  categories: CategoryDTO[];
  onClose: () => void;
  onApply: (filters: ActivityFilters) => void;
};

type PresetKind = "all" | "this_month" | "last_month" | "last_30" | "ytd";

const PRESETS: ReadonlyArray<{ kind: PresetKind; label: string }> = [
  { kind: "all", label: "All time" },
  { kind: "this_month", label: "This month" },
  { kind: "last_month", label: "Last month" },
  { kind: "last_30", label: "Last 30 days" },
  { kind: "ytd", label: "Year to date" },
];

const DIRECTIONS: ReadonlyArray<{
  value: ActivityDirectionFilter;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "expense", label: "Expenses" },
  { value: "income", label: "Income" },
];

function ymd(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function presetRange(kind: PresetKind): DateRange {
  const now = new Date();
  if (kind === "all") return {};
  if (kind === "this_month") {
    return {
      from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)),
      to: ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
    };
  }
  if (kind === "last_month") {
    const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return {
      from: ymd(previous),
      to: ymd(new Date(previous.getFullYear(), previous.getMonth() + 1, 0)),
    };
  }
  if (kind === "last_30") {
    const start = new Date(now);
    start.setDate(start.getDate() - 29);
    return { from: ymd(start), to: ymd(now) };
  }
  return { from: ymd(new Date(now.getFullYear(), 0, 1)), to: ymd(now) };
}

function detectPreset(range: DateRange): PresetKind | null {
  if (!range.from && !range.to) return "all";
  for (const preset of PRESETS) {
    if (preset.kind === "all") continue;
    const candidate = presetRange(preset.kind);
    if (candidate.from === range.from && candidate.to === range.to) {
      return preset.kind;
    }
  }
  return null;
}

export function CategoryFilterSheet({
  visible,
  categories,
  selectedCategoryIds,
  direction,
  range,
  onClose,
  onApply,
}: Props) {
  const ref = useRef<BottomSheet>(null);
  const [draftCategories, setDraftCategories] = useState(() => new Set(selectedCategoryIds));
  const [draftDirection, setDraftDirection] = useState<ActivityDirectionFilter>(direction);
  const [draftRange, setDraftRange] = useState<DateRange>(range);
  const [picking, setPicking] = useState<"from" | "to" | null>(null);
  const snapPoints = useMemo(() => ["92%"], []);

  const activeCategories = useMemo(
    () =>
      categories
        .filter(
          (category) =>
            !category.archivedAt && (draftDirection === "all" || category.type === draftDirection),
        )
        .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)),
    [categories, draftDirection],
  );

  useEffect(() => {
    if (!visible) return;
    setDraftCategories(new Set(selectedCategoryIds));
    setDraftDirection(direction);
    setDraftRange(range);
    setPicking(null);
  }, [direction, range, selectedCategoryIds, visible]);

  const toggleCategory = useCallback((id: string) => {
    setDraftCategories((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const chooseDirection = useCallback(
    (nextDirection: ActivityDirectionFilter) => {
      setDraftDirection(nextDirection);
      if (nextDirection === "all") return;
      const allowed = new Set(
        categories
          .filter((category) => category.type === nextDirection)
          .map((category) => category.id),
      );
      setDraftCategories(
        (current) =>
          new Set([...current].filter((id) => id === UNCATEGORIZED_FILTER_ID || allowed.has(id))),
      );
    },
    [categories],
  );

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

  const activePreset = detectPreset(draftRange);

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
        <Text style={styles.title}>Filters</Text>
        <Pressable
          onPress={() => {
            onApply({
              direction: draftDirection,
              range: draftRange,
              selectedCategoryIds: [...draftCategories],
            });
            ref.current?.close();
          }}
          hitSlop={8}
        >
          <Text style={styles.apply}>Apply</Text>
        </Pressable>
      </View>

      <BottomSheetScrollView contentContainerStyle={styles.list}>
        <SectionLabel>Transaction type</SectionLabel>
        <View style={styles.segmented}>
          {DIRECTIONS.map((item) => {
            const selected = draftDirection === item.value;
            return (
              <Pressable
                key={item.value}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => chooseDirection(item.value)}
                style={[styles.segment, selected && styles.segmentActive]}
              >
                <Text style={[styles.segmentText, selected && styles.segmentTextActive]}>
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <SectionLabel>Date</SectionLabel>
        <View style={styles.chipWrap}>
          {PRESETS.map((preset) => {
            const selected = activePreset === preset.kind;
            return (
              <Pressable
                key={preset.kind}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => {
                  setDraftRange(presetRange(preset.kind));
                  setPicking(null);
                }}
                style={[styles.chip, selected && styles.chipActive]}
              >
                <Text style={[styles.chipText, selected && styles.chipTextActive]}>
                  {preset.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <View style={styles.customRow}>
          <DateButton
            label="From"
            {...(draftRange.from ? { value: draftRange.from } : {})}
            active={picking === "from"}
            onPress={() => setPicking(picking === "from" ? null : "from")}
          />
          <DateButton
            label="To"
            {...(draftRange.to ? { value: draftRange.to } : {})}
            active={picking === "to"}
            onPress={() => setPicking(picking === "to" ? null : "to")}
          />
        </View>
        {picking ? (
          <DateTimePicker
            value={
              (picking === "from" ? draftRange.from : draftRange.to)
                ? new Date(`${picking === "from" ? draftRange.from : draftRange.to}T12:00:00Z`)
                : new Date()
            }
            mode="date"
            display={Platform.OS === "ios" ? "spinner" : "default"}
            maximumDate={new Date()}
            onChange={(event: DateTimePickerEvent, selectedDate?: Date) => {
              if (Platform.OS === "android") setPicking(null);
              if (event.type !== "set" || !selectedDate) return;
              const nextValue = ymd(selectedDate);
              setDraftRange((current) => ({ ...current, [picking]: nextValue }));
            }}
            style={styles.datePicker}
          />
        ) : null}

        <SectionLabel>Categories</SectionLabel>
        <FilterRow
          label="All categories"
          subtitle={
            draftDirection === "all"
              ? "Show every category"
              : `Show all ${draftDirection} categories`
          }
          icon="apps-outline"
          selected={draftCategories.size === 0}
          onPress={() => setDraftCategories(new Set())}
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
                selected={draftCategories.has(category.id)}
                onPress={() => toggleCategory(category.id)}
              />
            </View>
          );
        })}
        <View style={styles.separator} />
        <FilterRow
          label="Uncategorized"
          icon="help-circle-outline"
          selected={draftCategories.has(UNCATEGORIZED_FILTER_ID)}
          onPress={() => toggleCategory(UNCATEGORIZED_FILTER_ID)}
        />

        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setDraftDirection("all");
            setDraftRange({});
            setDraftCategories(new Set());
            setPicking(null);
          }}
          style={({ pressed }) => [styles.reset, pressed && styles.rowPressed]}
        >
          <Text style={styles.resetText}>Reset all filters</Text>
        </Pressable>
      </BottomSheetScrollView>
    </BottomSheet>
  );
}

function SectionLabel({ children }: { children: string }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

function DateButton({
  label,
  value,
  active,
  onPress,
}: {
  label: string;
  value?: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.rangeButton, active && styles.rangeButtonActive]}>
      <Text style={styles.rangeLabel}>{label}</Text>
      <Text style={[styles.rangeValue, !value && styles.rangeValueEmpty]}>{value ?? "Any"}</Text>
    </Pressable>
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
  list: { paddingHorizontal: space.lg, paddingBottom: space.xxl },
  sectionLabel: {
    ...type$.bodySm,
    color: colors.muted,
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginTop: space.base,
    marginBottom: space.sm,
  },
  segmented: {
    flexDirection: "row",
    padding: 3,
    borderRadius: 12,
    backgroundColor: colors.surfaceSoft,
  },
  segment: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 10,
    borderRadius: 10,
  },
  segmentActive: { backgroundColor: colors.primary },
  segmentText: { ...type$.bodySm, color: colors.body, fontWeight: "600" },
  segmentTextActive: { color: colors.onPrimary },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: space.base,
    paddingVertical: 10,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 999,
  },
  chipActive: { backgroundColor: colors.primary },
  chipText: { ...type$.bodySm, color: colors.ink, fontWeight: "600" },
  chipTextActive: { color: colors.onPrimary },
  customRow: { flexDirection: "row", gap: 10, marginTop: space.sm },
  rangeButton: {
    flex: 1,
    paddingHorizontal: space.base,
    paddingVertical: 11,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "transparent",
    backgroundColor: colors.surfaceSoft,
  },
  rangeButtonActive: { borderColor: colors.primary },
  rangeLabel: { ...type$.captionStrong, color: colors.muted, textTransform: "uppercase" },
  rangeValue: { ...type$.bodyMd, color: colors.ink, fontWeight: "600", marginTop: 3 },
  rangeValueEmpty: { color: colors.mutedSoft },
  datePicker: { alignSelf: "stretch" },
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
  reset: { alignItems: "center", paddingVertical: space.base, marginTop: space.base },
  resetText: { ...type$.bodyMd, color: colors.down, fontWeight: "600" },
});
