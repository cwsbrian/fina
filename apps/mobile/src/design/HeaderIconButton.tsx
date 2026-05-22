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
};

/** Filled-circle icon button used on every top-level screen header
 *  (Activity / Chat / chat history / etc.). Matches the design system's
 *  .fm-iconbtn: 34px circle on surface-strong with ink-colored icon. */
export function HeaderIconButton({
  icon,
  onPress,
  accessibilityLabel,
  disabled,
  size = 19,
  color = colors.ink,
}: Props) {
  return (
    <Pressable
      style={({ pressed }) => [styles.btn, pressed && { opacity: 0.6 }]}
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
  btn: {
    width: 34,
    height: 34,
    borderRadius: 999,
    backgroundColor: colors.surfaceStrong,
    alignItems: "center",
    justifyContent: "center",
  },
});
