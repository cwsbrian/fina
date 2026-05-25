import { View, Text, StyleSheet } from "react-native";
import { colors, type as type$ } from "../design/tokens";

/** Compact indicator on transaction rows that still need user
 *  confirmation. Visual only — the surrounding row's onPress navigates
 *  to the transaction detail, where the confirm banner lives.
 *    - yellow chip: AI-categorized, awaiting first confirmation
 *    - red chip:    LLM dropped it into "Other" — review more urgently
 */
export function NeedsReviewDot({ isOther }: { isOther: boolean }) {
  return (
    <View style={[styles.chip, isOther ? styles.chipOther : styles.chipNormal]}>
      <Text
        style={[
          styles.text,
          isOther ? styles.textOther : styles.textNormal,
        ]}
      >
        Review
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
  },
  chipNormal: { backgroundColor: "rgba(230, 184, 92, 0.18)" },
  chipOther: { backgroundColor: "rgba(207, 32, 47, 0.10)" },
  text: { ...type$.captionStrong, fontSize: 11 },
  textNormal: { color: colors.accentYellow },
  textOther: { color: colors.down },
});
