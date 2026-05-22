import { useRef } from "react";
import { Animated, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";

type Result = {
  /** Apply to the Animated.View wrapping the screen header. */
  headerStyle: { transform: { translateY: Animated.Value }[] };
  /** Attach to the scrollable child's onScroll prop. */
  onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** scrollEventThrottle to pair with onScroll — 16 (~60fps) is the
   *  smoothest value RN supports without overwhelming the JS bridge. */
  scrollEventThrottle: number;
};

const HIDE_THRESHOLD = 8;        // px delta before we react (jitter floor)
const ANIM_DURATION_MS = 180;

/** Hide the header when the user scrolls DOWN past it; reveal again on
 *  the first upward gesture. The header should be absolutely positioned
 *  at the top of the screen (so hiding doesn't leave a layout gap) and
 *  the scrollable child should reserve `headerHeight` worth of top
 *  padding (typically `<ScrollView contentContainerStyle={{ paddingTop:
 *  headerHeight }}>`). */
export function useCollapsingHeader(headerHeight: number): Result {
  const translateY = useRef(new Animated.Value(0)).current;
  const lastY = useRef(0);
  // Track which way the header is currently animating so we don't
  // re-fire the same direction on every scroll event.
  const dir = useRef<"up" | "down">("up");

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    const dy = y - lastY.current;
    lastY.current = y;
    if (Math.abs(dy) < HIDE_THRESHOLD) return;

    // Near the top: always reveal — feels weird to have a hidden
    // header when the content above is already visible.
    if (y < headerHeight) {
      if (dir.current !== "up") {
        dir.current = "up";
        Animated.timing(translateY, {
          toValue: 0,
          duration: ANIM_DURATION_MS,
          useNativeDriver: true,
        }).start();
      }
      return;
    }

    if (dy > 0 && dir.current !== "down") {
      dir.current = "down";
      Animated.timing(translateY, {
        toValue: -headerHeight,
        duration: ANIM_DURATION_MS,
        useNativeDriver: true,
      }).start();
    } else if (dy < 0 && dir.current !== "up") {
      dir.current = "up";
      Animated.timing(translateY, {
        toValue: 0,
        duration: ANIM_DURATION_MS,
        useNativeDriver: true,
      }).start();
    }
  };

  return {
    headerStyle: { transform: [{ translateY }] },
    onScroll,
    scrollEventThrottle: 16,
  };
}
