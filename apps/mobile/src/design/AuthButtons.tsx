import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  ViewStyle,
} from "react-native";
import Svg, { Path } from "react-native-svg";
import { colors, type } from "./tokens";

type CTAProps = {
  label: string;
  onPress?: () => void;
  busy?: boolean;
  disabled?: boolean;
  variant?: "primary" | "ink";
  style?: ViewStyle;
};

export function AuthCTA({
  label,
  onPress,
  busy,
  disabled,
  variant = "primary",
  style,
}: CTAProps) {
  const isDisabled = disabled || busy;
  const bg =
    isDisabled
      ? colors.surfaceStrong
      : variant === "primary"
        ? colors.primary
        : colors.ink;
  const color = isDisabled ? colors.muted : "#fff";
  return (
    <Pressable
      onPress={isDisabled ? undefined : onPress}
      style={[styles.cta, { backgroundColor: bg }, style]}
    >
      {busy ? (
        <ActivityIndicator color={color} />
      ) : (
        <Text style={[styles.ctaText, { color }]}>{label}</Text>
      )}
    </Pressable>
  );
}

type SocialProps = {
  provider: "google" | "apple" | "magic";
  label: string;
  onPress?: () => void;
  busy?: boolean;
  disabled?: boolean;
};

export function SocialButton({ provider, label, onPress, busy, disabled }: SocialProps) {
  const isApple = provider === "apple";
  const isDisabled = disabled || busy;
  return (
    <Pressable
      onPress={isDisabled ? undefined : onPress}
      style={[
        styles.social,
        isApple && { backgroundColor: colors.ink, borderColor: colors.ink },
        isDisabled && { opacity: 0.6 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={isApple ? "#fff" : colors.ink} />
      ) : (
        <>
          {provider === "google" && <GoogleGlyph />}
          {provider === "apple" && <AppleGlyph />}
          {provider === "magic" && <MailGlyph />}
          <Text
            style={[
              styles.socialText,
              isApple && { color: "#fff" },
              provider === "magic" && { fontWeight: "500" },
            ]}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

function GoogleGlyph() {
  return (
    <Svg width={18} height={18} viewBox="0 0 18 18">
      <Path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.17-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.56 2.7-3.87 2.7-6.62z" />
      <Path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.83.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.94v2.34A9 9 0 0 0 9 18z" />
      <Path fill="#FBBC05" d="M3.95 10.7a5.41 5.41 0 0 1 0-3.4V4.96H.94a9 9 0 0 0 0 8.08l3.01-2.34z" />
      <Path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58A9 9 0 0 0 .94 4.96L3.95 7.3C4.66 5.17 6.65 3.58 9 3.58z" />
    </Svg>
  );
}

function AppleGlyph() {
  return (
    <Svg width={16} height={18} viewBox="0 0 16 18">
      <Path
        fill="#fff"
        d="M13.05 9.55c-.02-2.13 1.74-3.16 1.82-3.21-1-1.46-2.55-1.66-3.1-1.68-1.32-.13-2.58.78-3.25.78-.67 0-1.71-.76-2.81-.74-1.45.02-2.78.84-3.53 2.13-1.5 2.6-.38 6.43 1.08 8.54.72 1.03 1.57 2.19 2.68 2.15 1.07-.04 1.48-.69 2.78-.69s1.67.69 2.81.67c1.16-.02 1.9-1.05 2.6-2.09a9.2 9.2 0 0 0 1.18-2.42c-.03-.01-2.26-.87-2.28-3.44zM10.96 3.32c.59-.71.98-1.7.87-2.69-.84.03-1.86.56-2.46 1.27-.54.63-1.01 1.64-.88 2.61.94.07 1.89-.48 2.47-1.19z"
      />
    </Svg>
  );
}

function MailGlyph() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={colors.body} strokeWidth={1.8}>
      <Path d="M2 4h20v16H2z M22 4l-10 8L2 4" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  cta: {
    height: 54,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  ctaText: { ...type.button },
  social: {
    height: 50,
    borderRadius: 999,
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 10,
  },
  socialText: { ...type.button, color: colors.ink },
});
