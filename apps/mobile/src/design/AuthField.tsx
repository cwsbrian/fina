import { useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
} from "react-native";
import { colors, radius, type } from "./tokens";
import { Icon } from "./Icon";

type Props = TextInputProps & {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  secret?: boolean;
  strength?: string | undefined;
};

export function AuthField({
  label,
  value,
  onChangeText,
  secret = false,
  strength,
  ...rest
}: Props) {
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(secret);
  const filled = value.length > 0;
  const labelFloated = focused || filled;

  return (
    <View
      style={[
        styles.field,
        focused && styles.fieldFocused,
        !focused && filled && styles.fieldFilled,
      ]}
    >
      <Text
        style={[styles.label, labelFloated ? styles.labelFloated : styles.labelInline]}
      >
        {label}
      </Text>
      <TextInput
        {...rest}
        value={value}
        onChangeText={onChangeText}
        onFocus={(e) => {
          setFocused(true);
          rest.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          rest.onBlur?.(e);
        }}
        secureTextEntry={hidden}
        style={styles.input}
        placeholderTextColor={colors.mutedSoft}
      />
      {strength && filled ? (
        <Text style={styles.strength}>{strength}</Text>
      ) : null}
      {secret ? (
        <Pressable
          onPress={() => setHidden((v) => !v)}
          style={styles.eye}
          hitSlop={8}
          accessibilityLabel={hidden ? "Show password" : "Hide password"}
        >
          <Icon name={hidden ? "eye" : "eyeOff"} size={18} color={colors.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    height: 54,
    borderRadius: 14,
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: "transparent",
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  fieldFocused: {
    borderColor: colors.ink,
    backgroundColor: colors.canvas,
  },
  fieldFilled: {},
  label: {
    position: "absolute",
    left: 16,
    color: colors.muted,
  },
  labelInline: {
    ...type.bodyMd,
    top: 17,
  },
  labelFloated: {
    ...type.captionStrong,
    top: 9,
    textTransform: "uppercase",
  },
  input: {
    ...type.bodyMd,
    fontWeight: "500",
    color: colors.ink,
    paddingTop: 18,
    paddingBottom: 4,
    paddingRight: 40,
    height: 54,
  },
  strength: {
    position: "absolute",
    right: 56,
    top: 20,
    fontSize: 11,
    fontWeight: "600",
    color: colors.up,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  eye: {
    position: "absolute",
    right: 12,
    top: 11,
    width: 32,
    height: 32,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
});
