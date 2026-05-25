import { Text, Pressable, StyleSheet } from "react-native";
import { colors, type as type$ } from "../design/tokens";

export function NeedsReviewPill({ isOther, onPress }: { isOther: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={12}
      style={[styles.pill, isOther ? styles.pillOther : styles.pillNormal]}
    >
      <Text style={[styles.text, isOther ? styles.textOther : styles.textNormal]}>
        Needs review
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 999, borderWidth: 1,
    backgroundColor: colors.surfaceSoft,
  },
  pillNormal: { borderColor: colors.accentYellow },
  pillOther:  { borderColor: colors.down },
  text: { ...type$.captionStrong },
  textNormal: { color: colors.accentYellow },
  textOther:  { color: colors.down },
});
