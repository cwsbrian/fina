import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, space, type as type$ } from "../design/tokens";

export function MaintenanceScreen({ onRetry }: { onRetry?: () => void }) {
  return (
    <View style={styles.root}>
      <View style={styles.iconWrap}>
        <Ionicons name="cloud-offline-outline" size={30} color={colors.primaryActive} />
      </View>
      <Text style={styles.title}>Fina is temporarily unavailable</Text>
      <Text style={styles.body}>
        We couldn't connect to the backend. Please check your connection or try again in a moment.
      </Text>
      {onRetry ? (
        <Pressable
          style={({ pressed }) => [styles.retry, pressed && { opacity: 0.75 }]}
          onPress={onRetry}
        >
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space.xl,
    backgroundColor: colors.canvas,
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 20,
    backgroundColor: "#dff3eb",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.md,
  },
  title: {
    ...type$.titleMd,
    color: colors.ink,
    textAlign: "center",
    marginBottom: space.xs,
  },
  body: {
    ...type$.bodySm,
    color: colors.body,
    textAlign: "center",
    maxWidth: 320,
  },
  retry: {
    marginTop: space.lg,
    minHeight: 44,
    paddingHorizontal: space.lg,
    borderRadius: 22,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  retryText: {
    ...type$.button,
    color: colors.onPrimary,
  },
});
