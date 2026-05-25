import { View, StyleSheet } from "react-native";
import { colors } from "../design/tokens";

/** Minimal dot indicator on transaction rows that still need user
 *  confirmation. Color signals urgency:
 *    - yellow: AI-categorized, awaiting first confirmation
 *    - red:    LLM dropped it into "Other" — needs review more urgently
 *  Visual only — the surrounding row's onPress navigates to the
 *  transaction detail, where the confirm banner lives. */
export function NeedsReviewDot({ isOther }: { isOther: boolean }) {
  return (
    <View style={[styles.dot, isOther ? styles.dotOther : styles.dotNormal]} />
  );
}

const styles = StyleSheet.create({
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dotNormal: { backgroundColor: colors.accentYellow },
  dotOther:  { backgroundColor: colors.down },
});
