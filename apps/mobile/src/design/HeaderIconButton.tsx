import { Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "./tokens";

type Props = {
  icon: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
  accessibilityLabel?: string;
  disabled?: boolean;
  /** Icon size in pixels (default 19). */
  size?: number;
  /** Optional override for the icon color (defaults to ink). */
  color?: string;
  /** `filled` (default) — 34px circle on surface-strong, used on every
   *  top-level tab screen (Activity / Chat / etc.). `plain` — no
   *  background, used on drill-in / sub-screen headers (back arrows,
   *  detail screens). */
  variant?: "filled" | "plain";
};

export function HeaderIconButton({
  icon,
  onPress,
  accessibilityLabel,
  disabled,
  size = 19,
  color = colors.ink,
  variant = "filled",
}: Props) {
  return (
    <Pressable
      style={({ pressed }) => [
        variant === "filled" ? styles.filled : styles.plain,
        pressed && { opacity: 0.6 },
      ]}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel}
      hitSlop={8}
    >
      <Ionicons name={icon} size={size} color={color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  filled: {
    width: 34,
    height: 34,
    borderRadius: 999,
    backgroundColor: colors.surfaceStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  plain: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
});
