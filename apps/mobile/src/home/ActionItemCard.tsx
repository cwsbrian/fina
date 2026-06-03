import { Pressable, Text, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, space, type as type$ } from "../design/tokens";

export type ActionItemCardProps = {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  variant?: "default" | "solid";
  onPress: () => void;
};

export function ActionItemCard({
  icon,
  title,
  subtitle,
  variant = "default",
  onPress,
}: ActionItemCardProps) {
  const solid = variant === "solid";
  return (
    <Pressable
      style={({ pressed }) => [
        styles.card,
        solid && styles.cardSolid,
        pressed && { opacity: 0.7 },
      ]}
      onPress={onPress}
    >
      <View style={[styles.glyph, solid && styles.glyphSolid]}>
        <Ionicons
          name={icon}
          size={18}
          color={solid ? colors.primaryActive : colors.primary}
        />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.title, solid && styles.titleSolid]}>{title}</Text>
        {subtitle ? (
          <Text style={[styles.sub, solid && styles.subSolid]}>{subtitle}</Text>
        ) : null}
      </View>
      <Ionicons
        name="chevron-forward"
        size={16}
        color={solid ? colors.primaryActive : colors.mutedSoft}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 16,
    padding: space.base,
    marginBottom: space.sm,
    gap: space.sm,
  },
  cardSolid: {
    backgroundColor: "#dff3eb",
    borderColor: "#bfe6d6",
  },
  glyph: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  glyphSolid: {
    backgroundColor: colors.canvas,
  },
  title: { ...type$.titleSm, color: colors.ink },
  titleSolid: { color: colors.ink },
  sub: { ...type$.bodySm, color: colors.body, marginTop: 2 },
  subSolid: { color: colors.body },
});
