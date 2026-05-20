import { StyleSheet, Text, TextStyle } from "react-native";
import { colors } from "./tokens";

type Props = {
  size?: number;
  color?: string;
  style?: TextStyle;
};

export function Wordmark({ size = 44, color = colors.primary, style }: Props) {
  return (
    <Text
      style={[
        styles.base,
        { fontSize: size, color, letterSpacing: -(size * 0.034) },
        style,
      ]}
    >
      Fina
    </Text>
  );
}

const styles = StyleSheet.create({
  base: {
    fontWeight: "500",
    lineHeight: undefined,
  },
});
