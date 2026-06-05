import { Image, ImageStyle, StyleProp, StyleSheet } from "react-native";
import { colors } from "./tokens";

type Props = {
  size?: number;
  color?: string;
  style?: StyleProp<ImageStyle>;
};

export function Wordmark({ size = 44, color = colors.primary, style }: Props) {
  const light =
    color.toLowerCase() === "#fff" ||
    color.toLowerCase() === "#ffffff" ||
    color === colors.onDark ||
    color === colors.onPrimary;

  return (
    <Image
      source={
        light
          ? require("../../assets/fina-wordmark-light.png")
          : require("../../assets/fina-wordmark.png")
      }
      style={[
        styles.base,
        {
          height: size,
          width: size * (1202 / 302),
        },
        style,
      ]}
      accessibilityLabel="Fina"
      resizeMode="contain"
    />
  );
}

const styles = StyleSheet.create({
  base: {
    alignSelf: "flex-start",
  },
});
