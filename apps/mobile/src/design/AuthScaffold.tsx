import { ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { colors } from "./tokens";
import { Icon } from "./Icon";

type Props = {
  children: ReactNode;
  onBack?: () => void;
  centered?: boolean;
  foot?: ReactNode;
  hideBack?: boolean;
};

export function AuthScaffold({
  children,
  onBack,
  centered,
  foot,
  hideBack,
}: Props) {
  return (
    <SafeAreaView style={styles.root}>
      {!hideBack && (
        <Pressable
          onPress={onBack ?? (() => router.back())}
          style={styles.back}
          hitSlop={12}
          accessibilityLabel="Back"
        >
          <Icon name="chevLeft" size={22} color={colors.ink} strokeWidth={1.8} />
        </Pressable>
      )}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[
            styles.scroll,
            centered && { justifyContent: "center", paddingBottom: 80 },
          ]}
        >
          <View style={styles.body}>{children}</View>
        </ScrollView>
        {foot ? <View style={styles.foot}>{foot}</View> : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  back: {
    position: "absolute",
    top: 56,
    left: 12,
    width: 38,
    height: 38,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 60,
    paddingBottom: 24,
  },
  body: { flex: 1 },
  foot: {
    paddingHorizontal: 24,
    paddingBottom: 28,
    alignItems: "center",
  },
});
