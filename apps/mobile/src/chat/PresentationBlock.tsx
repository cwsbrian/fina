import { View, Text, StyleSheet, Pressable } from "react-native";
import type { PresentationBlock as Block } from "@fina/shared";
import { colors, space, type as type$ } from "../design/tokens";

type Props = {
  block: Block;
  role: "user" | "assistant" | "tool";
  onAccept?: (intent: string) => void;
  onReject?: (intent: string | undefined) => void;
};

/** Renders a single presentation block. Exhaustive over the
 *  PresentationBlock union; new block types fail at the never-cast and
 *  show a debug pill so the user sees something instead of nothing. */
export function PresentationBlock({ block, role, onAccept, onReject }: Props) {
  if (block.type === "text") {
    return (
      <Text style={role === "user" ? styles.userText : styles.assistantText}>
        {block.markdown}
      </Text>
    );
  }
  if (block.type === "confirm_card") {
    return (
      <View style={styles.card}>
        <Text style={styles.cardQuestion}>{block.question}</Text>
        <View style={styles.cardActions}>
          <Pressable
            style={({ pressed }) => [
              styles.cardBtn,
              styles.cardBtnReject,
              pressed && { opacity: 0.7 },
            ]}
            onPress={() => onReject?.(block.reject_intent)}
          >
            <Text style={styles.cardBtnRejectText}>{block.reject_label}</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.cardBtn,
              styles.cardBtnAccept,
              pressed && { opacity: 0.85 },
            ]}
            onPress={() => onAccept?.(block.accept_intent)}
          >
            <Text style={styles.cardBtnAcceptText}>{block.accept_label}</Text>
          </Pressable>
        </View>
      </View>
    );
  }
  // Exhaustiveness — newer block types render a debug pill so users
  // see SOMETHING rather than a blank message.
  const _exhaustive: never = block;
  return (
    <View style={styles.unknown}>
      <Text style={styles.unknownText}>
        (Unsupported message type — update the app.)
      </Text>
      <Text style={{ display: "none" }}>{JSON.stringify(_exhaustive)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  userText: {
    ...type$.bodyMd,
    color: colors.onPrimary,
  },
  assistantText: {
    ...type$.bodyMd,
    color: colors.ink,
  },
  card: {
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 14,
    padding: space.base,
    marginVertical: 4,
  },
  cardQuestion: {
    ...type$.titleSm,
    color: colors.ink,
    marginBottom: space.sm,
  },
  cardActions: {
    flexDirection: "row",
    gap: space.xs,
  },
  cardBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 999,
    alignItems: "center",
  },
  cardBtnAccept: { backgroundColor: colors.primary },
  cardBtnReject: {
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  cardBtnAcceptText: { ...type$.button, color: colors.onPrimary },
  cardBtnRejectText: { ...type$.button, color: colors.ink },
  unknown: {
    padding: space.sm,
    borderRadius: 8,
    backgroundColor: colors.surfaceSoft,
  },
  unknownText: { ...type$.caption, color: colors.muted },
});
