import { View, Text, Pressable, StyleSheet } from "react-native";
import { router } from "expo-router";
import type { PresentationBlock } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";
import { BlockCard, BlockHeader, BlockFooter, BlockEmpty, withAlpha, CategoryIcon } from "./_primitives";

type Block = Extract<PresentationBlock, { type: "category_list" }>;

export function CategoryListBlock({ block }: { block: Block }) {
  return (
    <Pressable
      onPress={() => router.push("/categories" as never)}
      accessibilityRole="button"
      accessibilityLabel="Manage categories"
      style={({ pressed }) => (pressed ? { opacity: 0.7 } : null)}
    >
    <BlockCard>
      <BlockHeader title={block.title} />
      {block.rows.length === 0 ? (
        <BlockEmpty text="No categories yet." />
      ) : (
        <View style={styles.chips}>
          {block.rows.map((r) => (
            <View
              key={r.id}
              style={[styles.chip, { backgroundColor: r.color ? withAlpha(r.color, 0.13) : colors.surfaceSoft }]}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <CategoryIcon icon={r.icon} color={r.color} size={13} />
                <Text style={[styles.chipText, { color: r.color ?? colors.body }]} numberOfLines={1}>
                  {r.name}
                </Text>
              </View>
            </View>
          ))}
        </View>
      )}
      {block.footer ? <BlockFooter text={block.footer} /> : null}
    </BlockCard>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: space.xs },
  chip: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999 },
  chipText: { ...type$.caption, fontWeight: "600" },
});
